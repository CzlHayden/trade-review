import { test, expect } from "bun:test";
import { openTestDb, fill, order, rawPos } from "../helpers";
import {
  upsertRawFills,
  upsertRawOrders,
  insertPositionSnapshot,
  allRawFills,
  allRawOrders,
  latestPositions,
  replaceDerived,
  allTrades,
  flagsForTrade,
} from "../../src/store/repos";
import type { Flag, Trade } from "../../src/domain/types";

test("upsertRawFills inserts and reads back, ordered by time", () => {
  const db = openTestDb();
  upsertRawFills(db, [
    fill("BUY", 100, 10, { id: "f2", time: 2000 }),
    fill("SELL", 100, 11, { id: "f1", time: 1000 }),
  ]);
  const rows = allRawFills(db);
  expect(rows.map((r) => r.id)).toEqual(["f1", "f2"]); // time-ordered
  expect(rows[0]!.side).toBe("SELL");
  expect(rows[1]!.price).toBe(10);
});

test("upsertRawFills is idempotent — re-inserting the same id updates, never duplicates", () => {
  const db = openTestDb();
  upsertRawFills(db, [fill("BUY", 100, 10, { id: "f1" })]);
  upsertRawFills(db, [fill("BUY", 100, 12, { id: "f1" })]); // same id, new price
  const rows = allRawFills(db);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.price).toBe(12); // last write wins
});

test("upsertRawOrders round-trips nullable price/triggerPrice/updateTime", () => {
  const db = openTestDb();
  upsertRawOrders(db, [
    order("SELL", "STOP", 100, { id: "o1", price: null, triggerPrice: 9, updateTime: null, createTime: 1000 }),
    order("BUY", "LIMIT", 50, { id: "o2", price: 8, triggerPrice: null, updateTime: 2000, createTime: 1500 }),
  ]);
  const rows = allRawOrders(db);
  expect(rows.map((r) => r.id)).toEqual(["o1", "o2"]); // createTime-ordered
  expect(rows[0]!.price).toBeNull();
  expect(rows[0]!.triggerPrice).toBe(9);
  expect(rows[0]!.updateTime).toBeNull();
  expect(rows[1]!.updateTime).toBe(2000);
});

test("insertPositionSnapshot keeps one row per (account,symbol,time); latestPositions returns newest per symbol", () => {
  const db = openTestDb();
  insertPositionSnapshot(db, [rawPos(100, 10, { symbol: "AAPL", time: 1000 })]);
  insertPositionSnapshot(db, [rawPos(150, 10.5, { symbol: "AAPL", time: 2000 })]); // newer snapshot
  insertPositionSnapshot(db, [rawPos(-20, 300, { symbol: "TSLA", time: 1500 })]);
  const latest = latestPositions(db);
  const aapl = latest.find((p) => p.symbol === "AAPL")!;
  expect(aapl.qty).toBe(150); // the 2000 snapshot, not the 1000 one
  expect(aapl.avgCost).toBe(10.5);
  expect(latest.find((p) => p.symbol === "TSLA")!.qty).toBe(-20);
});

test("insertPositionSnapshot re-inserting the same (account,symbol,time) replaces, not duplicates", () => {
  const db = openTestDb();
  insertPositionSnapshot(db, [rawPos(100, 10, { time: 1000 })]);
  insertPositionSnapshot(db, [rawPos(120, 10, { time: 1000 })]); // same key
  expect(latestPositions(db)).toHaveLength(1);
  expect(latestPositions(db)[0]!.qty).toBe(120);
});

test("empty reads return empty arrays", () => {
  const db = openTestDb();
  expect(allRawFills(db)).toEqual([]);
  expect(allRawOrders(db)).toEqual([]);
  expect(latestPositions(db)).toEqual([]);
});

function tradeFixture(over: Partial<Trade> = {}): Trade {
  return {
    id: over.id ?? "acc1:AAPL:1000:f1",
    account: "acc1", symbol: "AAPL", currency: "USD", direction: "LONG", status: "closed",
    openTime: 1000, closeTime: 2000, avgEntry: 10, avgExit: 11, maxQty: 100,
    realizedPnl: 100, fees: 1, holdSeconds: 1, coverageOk: true, fillIds: ["f1", "f2"],
    effectiveStop: 9, effectiveTp: null, risk: 100, rMultiple: 1, mae: 0.5, mfe: 2,
    ...over,
  };
}

test("replaceDerived writes trades, their fill links, and flags", () => {
  const db = openTestDb();
  const t = tradeFixture();
  const flags: Flag[] = [{ ruleId: "cut_winner_early", severity: "warn", reason: "left money" }];
  replaceDerived(db, [t], new Map([[t.id, flags]]));

  const got = allTrades(db);
  expect(got).toHaveLength(1);
  expect(got[0]!.id).toBe(t.id);
  expect(got[0]!.coverageOk).toBe(true);
  expect(got[0]!.effectiveStop).toBe(9);
  expect(got[0]!.effectiveTp).toBeNull();
  expect(got[0]!.fillIds.sort()).toEqual(["f1", "f2"]);
  expect(flagsForTrade(db, t.id)).toEqual(flags);
});

test("replaceDerived fully replaces prior derived data (idempotent rebuild)", () => {
  const db = openTestDb();
  const a = tradeFixture({ id: "a", fillIds: ["fa"] });
  replaceDerived(db, [a], new Map([["a", [{ ruleId: "oversized", severity: "warn", reason: "big" }]]]));
  // Second rebuild with a different trade set — the first must be gone entirely.
  const b = tradeFixture({ id: "b", fillIds: ["fb"] });
  replaceDerived(db, [b], new Map());

  expect(allTrades(db).map((t) => t.id)).toEqual(["b"]);
  expect(flagsForTrade(db, "a")).toEqual([]); // old flags wiped
  expect(flagsForTrade(db, "b")).toEqual([]);
});

test("replaceDerived round-trips an open trade with null exit/pnl/enrichment", () => {
  const db = openTestDb();
  const open = tradeFixture({
    id: "open", status: "open", closeTime: null, avgExit: null, realizedPnl: null,
    holdSeconds: null, coverageOk: false, effectiveStop: null, risk: null, rMultiple: null,
    mae: null, mfe: null, fillIds: ["fo"],
  });
  replaceDerived(db, [open], new Map());
  const got = allTrades(db)[0]!;
  expect(got.status).toBe("open");
  expect(got.closeTime).toBeNull();
  expect(got.realizedPnl).toBeNull();
  expect(got.coverageOk).toBe(false);
  expect(got.mae).toBeNull();
});

test("allTrades returns trades ordered by open_time then id", () => {
  const db = openTestDb();
  replaceDerived(
    db,
    [tradeFixture({ id: "late", openTime: 5000 }), tradeFixture({ id: "early", openTime: 1000 })],
    new Map(),
  );
  expect(allTrades(db).map((t) => t.id)).toEqual(["early", "late"]);
});
