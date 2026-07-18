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
  const t = longTrade(); // window [60000, 180000), entry 10, exit 12
  const candles = [
    candle(0, 1, 100), // bar [0, 60000) ends at open, not fully inside → ignored
    candle(240_000, 1, 100), // well after close → ignored
    candle(120_000, 9, 11),
  ];
  const r = computeExcursion(t, candles, RES);
  expect(r.mfe).toBe(2); // exit fill at 12 is a real favorable point, above the bar high of 11
  expect(r.mae).toBe(1); // 10 - 9
});

test("a boundary bar straddling entry is EXCLUDED — its extremes may predate the fill", () => {
  // The ANET bug: enter mid-bar at 90000 AFTER an early spike. The 60000 bar [60000,120000) straddles
  // openTime, so its high/low can be pre-entry price the trade never held → it must not count.
  const t = buildTrades([
    fill("BUY", 100, 10, { time: 90_000 }),
    fill("SELL", 100, 9, { time: 150_000 }), // straddles close too; window [90000,150000)
  ])[0]!;
  const candles = [candle(60_000, 8, 20)]; // spike to 20 lives in the straddling entry bar
  const r = computeExcursion(t, candles, RES);
  expect(r.mfe).toBe(0); // NOT 10 — the 20 high predates entry; no in-hold bar shows a gain
  expect(r.mae).toBe(1); // 10 - 9, from the exit anchor (the 8 low is also outside the hold)
});

test("a boundary bar straddling exit is EXCLUDED — its extremes may postdate the fill", () => {
  // The AMD bug: the exit bar's low happened AFTER the exit fill and must not inflate MAE.
  const t = longTrade(); // window [60000, 180000), entry 10, exit 12
  const candles = [candle(120_000, 9, 11), candle(150_000, 1, 100)]; // 150000 bar straddles close 180000
  const r = computeExcursion(t, candles, RES);
  expect(r.mfe).toBe(2); // exit at 12; the 100 high in the straddling bar is ignored
  expect(r.mae).toBe(1); // 10 - 9; the post-exit 1 low is ignored
});

test("no fully-inside bar → excursion falls back to the entry/exit fills", () => {
  // Short trade whose whole hold sits inside one straddling bar: no bar is fully inside, so the fills
  // anchor it. Never over-states, and a losing short still shows its adverse move to the exit.
  const short = buildTrades([
    fill("SELL", 100, 20, { time: 90_000 }),
    fill("BUY", 100, 22, { time: 150_000 }), // loss: covered higher
  ])[0]!;
  const candles = [candle(60_000, 5, 40)]; // one bar straddling the whole hold
  const r = computeExcursion(short, candles, RES);
  expect(r.mfe).toBe(0); // never went favorable (below 20) on any in-hold evidence
  expect(r.mae).toBe(2); // 22 - 20, the adverse move to the exit fill
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
