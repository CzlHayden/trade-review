import { test, expect } from "bun:test";
import { buildTrades } from "../../src/core/trade-builder";
import { fill } from "../helpers";
import type { SeedPosition } from "../../src/domain/types";

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

test("seeded pre-existing position is flagged coverage_ok=false", () => {
  const seeds: SeedPosition[] = [{ account: "acc1", symbol: "AAPL", qty: 100 }];
  const trades = buildTrades([fill("SELL", 100, 12)], seeds);
  expect(trades).toHaveLength(1);
  expect(trades[0]!.status).toBe("closed");
  expect(trades[0]!.coverageOk).toBe(false);
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
