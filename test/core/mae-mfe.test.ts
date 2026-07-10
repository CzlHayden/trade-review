import { test, expect } from "bun:test";
import { computeExcursion } from "../../src/core/mae-mfe";
import { buildTrades } from "../../src/core/trade-builder";
import { fill, candle } from "../helpers";

function longTrade() {
  // BUY 100 @ 10 at t=60000, SELL 100 @ 12 at t=180000 → window [60000, 180000].
  return buildTrades([
    fill("BUY", 100, 10, { time: 60_000 }),
    fill("SELL", 100, 12, { time: 180_000 }),
  ])[0]!;
}

test("long: MFE from highest high, MAE from lowest low", () => {
  const t = longTrade();
  const candles = [
    candle(60_000, 9, 11), // low 9, high 11
    candle(120_000, 8, 13), // low 8 (worst), high 13 (best)
  ];
  const r = computeExcursion(t, candles);
  expect(r.mfe).toBe(3); // 13 - 10
  expect(r.mae).toBe(2); // 10 - 8
});

test("short: MFE from lowest low, MAE from highest high", () => {
  const short = buildTrades([
    fill("SELL", 100, 20, { time: 60_000 }),
    fill("BUY", 100, 18, { time: 180_000 }),
  ])[0]!;
  const candles = [candle(120_000, 17, 23)]; // low 17, high 23; entry 20
  const r = computeExcursion(short, candles);
  expect(r.mfe).toBe(3); // 20 - 17
  expect(r.mae).toBe(3); // 23 - 20
});

test("candles outside the trade window are ignored", () => {
  const t = longTrade(); // window [60000, 180000]
  const candles = [
    candle(30_000, 1, 100), // before open — ignored
    candle(240_000, 1, 100), // after close — ignored
    candle(120_000, 9, 11),
  ];
  const r = computeExcursion(t, candles);
  expect(r.mfe).toBe(1); // 11 - 10
  expect(r.mae).toBe(1); // 10 - 9
});

test("no candles in window → null", () => {
  const t = longTrade();
  expect(computeExcursion(t, [])).toEqual({ mae: null, mfe: null });
});

test("open trade uses all candles from openTime onward", () => {
  const openT = buildTrades([fill("BUY", 100, 10, { time: 60_000 })])[0]!;
  const candles = [candle(600_000, 8, 15)];
  const r = computeExcursion(openT, candles);
  expect(r.mfe).toBe(5); // 15 - 10
  expect(r.mae).toBe(2); // 10 - 8
});
