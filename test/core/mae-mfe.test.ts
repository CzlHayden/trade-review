import { test, expect } from "bun:test";
import { computeExcursion } from "../../src/core/mae-mfe";
import { buildTrades } from "../../src/core/trade-builder";
import { fill, candle } from "../helpers";

const RES = 60_000; // 1-minute bars in these fixtures

function longTrade() {
  // BUY 100 @ 10 at t=60000, SELL 100 @ 12 at t=180000 → window [60000, 180000).
  return buildTrades([
    fill("BUY", 100, 10, { time: 60_000 }),
    fill("SELL", 100, 12, { time: 180_000 }),
  ])[0]!;
}

test("long: MFE from highest high, MAE from lowest low", () => {
  const t = longTrade();
  const candles = [candle(60_000, 9, 11), candle(120_000, 8, 13)];
  const r = computeExcursion(t, candles, RES);
  expect(r.mfe).toBe(3); // 13 - 10
  expect(r.mae).toBe(2); // 10 - 8
});

test("short: MFE from lowest low, MAE from highest high", () => {
  const short = buildTrades([
    fill("SELL", 100, 20, { time: 60_000 }),
    fill("BUY", 100, 18, { time: 180_000 }),
  ])[0]!;
  const candles = [candle(120_000, 17, 23)]; // low 17, high 23; entry 20
  const r = computeExcursion(short, candles, RES);
  expect(r.mfe).toBe(3); // 20 - 17
  expect(r.mae).toBe(3); // 23 - 20
});

test("candles fully outside the trade window are ignored", () => {
  const t = longTrade(); // window [60000, 180000)
  const candles = [
    candle(0, 1, 100), // bar [0, 60000) ends exactly at open → no overlap → ignored
    candle(240_000, 1, 100), // well after close → ignored
    candle(120_000, 9, 11),
  ];
  const r = computeExcursion(t, candles, RES);
  expect(r.mfe).toBe(1); // 11 - 10, only the in-window bar counts
  expect(r.mae).toBe(1); // 10 - 9
});

test("the entry bar is included even though it starts before openTime", () => {
  // Enter mid-bar at 90000; the 60000 bar [60000,120000) contains the entry.
  const t = buildTrades([fill("BUY", 100, 10, { time: 90_000 })])[0]!;
  const candles = [candle(60_000, 8, 11)];
  const r = computeExcursion(t, candles, RES);
  expect(r.mae).toBe(2); // 10 - 8 — worst excursion in the entry bar is captured
  expect(r.mfe).toBe(1); // 11 - 10
});

test("a bar starting exactly at closeTime is excluded (fully post-exit)", () => {
  const t = longTrade(); // closes at 180000
  const candles = [candle(120_000, 9, 11), candle(180_000, 1, 100)];
  const r = computeExcursion(t, candles, RES);
  expect(r.mfe).toBe(1); // the post-exit 180000 bar does not pollute
  expect(r.mae).toBe(1);
});

test("MAE/MFE clamp to >= 0 when price never went adverse/favorable", () => {
  const t = longTrade(); // entry 10
  const candles = [candle(120_000, 11, 12)]; // price stayed above entry the whole time
  const r = computeExcursion(t, candles, RES);
  expect(r.mae).toBe(0); // would be -1 unclamped
  expect(r.mfe).toBe(2); // 12 - 10
});

test("no candles in window → null", () => {
  const t = longTrade();
  expect(computeExcursion(t, [], RES)).toEqual({ mae: null, mfe: null });
});

test("open trade uses all candles from openTime onward", () => {
  const openT = buildTrades([fill("BUY", 100, 10, { time: 60_000 })])[0]!;
  const candles = [candle(600_000, 8, 15)];
  const r = computeExcursion(openT, candles, RES);
  expect(r.mfe).toBe(5); // 15 - 10
  expect(r.mae).toBe(2); // 10 - 8
});
