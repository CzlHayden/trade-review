import { test, expect } from "bun:test";
import { buildTrades } from "../../src/core/trade-builder";
import { fill, seedPos } from "../helpers";

test("simple long round-trip", () => {
  const trades = buildTrades([fill("BUY", 100, 10), fill("SELL", 100, 12)]);
  expect(trades).toHaveLength(1);
  const t = trades[0]!;
  expect(t.direction).toBe("LONG");
  expect(t.status).toBe("closed");
  expect(t.avgEntry).toBe(10);
  expect(t.avgExit).toBe(12);
  expect(t.maxQty).toBe(100);
  expect(t.realizedPnl).toBe(200);
  expect(t.coverageOk).toBe(true);
});

test("simple short round-trip", () => {
  const trades = buildTrades([fill("SELL", 100, 12), fill("BUY", 100, 10)]);
  expect(trades).toHaveLength(1);
  const t = trades[0]!;
  expect(t.direction).toBe("SHORT");
  expect(t.realizedPnl).toBe(200); // sold 1200, bought back 1000
});

test("fees reduce realized pnl", () => {
  const trades = buildTrades([
    fill("BUY", 100, 10, { fee: 1 }),
    fill("SELL", 100, 12, { fee: 1 }),
  ]);
  expect(trades[0]!.realizedPnl).toBe(198);
  expect(trades[0]!.fees).toBe(2);
});

test("scale-in averages entry", () => {
  const trades = buildTrades([
    fill("BUY", 100, 10),
    fill("BUY", 100, 12),
    fill("SELL", 200, 15),
  ]);
  expect(trades).toHaveLength(1);
  expect(trades[0]!.avgEntry).toBe(11);
  expect(trades[0]!.maxQty).toBe(200);
  expect(trades[0]!.realizedPnl).toBe(800); // 3000 - 2200
});

test("partial scale-out then close", () => {
  const trades = buildTrades([
    fill("BUY", 100, 10),
    fill("SELL", 50, 12),
    fill("SELL", 50, 14),
  ]);
  expect(trades).toHaveLength(1);
  expect(trades[0]!.avgExit).toBe(13);
  expect(trades[0]!.realizedPnl).toBe(300); // 1300 - 1000
});

test("flip through zero splits into two trades", () => {
  const trades = buildTrades([fill("BUY", 100, 10), fill("SELL", 150, 12)]);
  expect(trades).toHaveLength(2);
  const [long, short] = trades;
  expect(long!.direction).toBe("LONG");
  expect(long!.status).toBe("closed");
  expect(long!.realizedPnl).toBe(200); // 100 @10 -> 100 @12
  expect(short!.direction).toBe("SHORT");
  expect(short!.status).toBe("open");
  expect(short!.avgEntry).toBe(12);
  expect(short!.maxQty).toBe(50);
});

test("still-open trade has null exit/pnl", () => {
  const trades = buildTrades([fill("BUY", 100, 10)]);
  expect(trades).toHaveLength(1);
  const t = trades[0]!;
  expect(t.status).toBe("open");
  expect(t.avgExit).toBeNull();
  expect(t.realizedPnl).toBeNull();
  expect(t.closeTime).toBeNull();
});

test("seeded pre-existing long uses avgCost for sane avgEntry and pnl", () => {
  // Held 100 @ cost 10, then sold 100 @ 12 → real profit is 200, not full proceeds.
  const trades = buildTrades([fill("SELL", 100, 12)], [seedPos(100, 10)]);
  expect(trades).toHaveLength(1);
  const t = trades[0]!;
  expect(t.status).toBe("closed");
  expect(t.coverageOk).toBe(false);
  expect(t.avgEntry).toBe(10);
  expect(t.realizedPnl).toBe(200);
});

test("seeded short uses avgCost", () => {
  // Held short 100 @ 12 (received 1200), bought back 100 @ 10 → profit 200.
  const trades = buildTrades([fill("BUY", 100, 10)], [seedPos(-100, 12)]);
  expect(trades).toHaveLength(1);
  const t = trades[0]!;
  expect(t.direction).toBe("SHORT");
  expect(t.status).toBe("closed");
  expect(t.realizedPnl).toBe(200);
});

test("seeded position plus an add averages entry with the seed cost", () => {
  // Seed 100 @ 10 (cost 1000), add BUY 50 @ 10 (cost 500) → 150 @ avg 10, sell 150 @ 12 → pnl 300.
  const trades = buildTrades([fill("BUY", 50, 10), fill("SELL", 150, 12)], [seedPos(100, 10)]);
  expect(trades).toHaveLength(1);
  const t = trades[0]!;
  expect(t.avgEntry).toBeCloseTo(10, 9);
  expect(t.maxQty).toBe(150);
  expect(t.realizedPnl).toBeCloseTo(300, 9);
  expect(t.holdSeconds).not.toBeNull();
  expect(t.holdSeconds!).toBeGreaterThanOrEqual(0); // openTime taken from first fill, not snapshot
});

test("seeded position with no fills still surfaces as an open trade", () => {
  const trades = buildTrades([], [seedPos(100, 10, { time: 5000 })]);
  expect(trades).toHaveLength(1);
  const t = trades[0]!;
  expect(t.status).toBe("open");
  expect(t.maxQty).toBe(100);
  expect(t.coverageOk).toBe(false);
  expect(t.openTime).toBe(5000);
});

test("fractional-share round-trip closes cleanly (float epsilon)", () => {
  const trades = buildTrades([
    fill("BUY", 0.1, 10),
    fill("BUY", 0.2, 10),
    fill("SELL", 0.3, 12),
  ]);
  expect(trades).toHaveLength(1);
  expect(trades[0]!.status).toBe("closed"); // not left "open" by 5e-17 residue
});

test("zero-qty fills are ignored (no NaN in fees/pnl)", () => {
  const trades = buildTrades([
    fill("BUY", 100, 10),
    fill("BUY", 0, 10, { fee: 1 }), // bogus zero-qty fill
    fill("SELL", 100, 12),
  ]);
  expect(trades).toHaveLength(1);
  expect(Number.isNaN(trades[0]!.fees)).toBe(false);
  expect(trades[0]!.realizedPnl).toBe(200);
});

test("same symbol on different accounts do not mix", () => {
  const trades = buildTrades([
    fill("BUY", 100, 10, { account: "accA" }),
    fill("BUY", 100, 20, { account: "accB" }),
    fill("SELL", 100, 11, { account: "accA" }),
    fill("SELL", 100, 22, { account: "accB" }),
  ]);
  expect(trades).toHaveLength(2);
  expect(trades.map((t) => t.account).sort()).toEqual(["accA", "accB"]);
});

test("trade ids are unique even when two trades open at the same timestamp", () => {
  // Flip: BUY 100, SELL 200, BUY 100 — the SELL closes the long and opens a short,
  // the final BUY closes the short — multiple trades, all at time t.
  const t = 1000;
  const trades = buildTrades([
    fill("BUY", 100, 10, { id: "a", time: t }),
    fill("SELL", 200, 12, { id: "b", time: t }),
    fill("BUY", 100, 11, { id: "c", time: t }),
  ]);
  const ids = trades.map((tr) => tr.id);
  expect(new Set(ids).size).toBe(ids.length); // no collisions
});

test("separate symbols and accounts do not mix", () => {
  const trades = buildTrades([
    fill("BUY", 100, 10, { symbol: "AAPL" }),
    fill("BUY", 50, 20, { symbol: "TSLA" }),
    fill("SELL", 100, 11, { symbol: "AAPL" }),
    fill("SELL", 50, 19, { symbol: "TSLA" }),
  ]);
  expect(trades).toHaveLength(2);
  expect(trades.map((t) => t.symbol).sort()).toEqual(["AAPL", "TSLA"]);
});
