import { test, expect } from "bun:test";
import { windowFor } from "../../src/core/candle-res";

const DAY = 86_400_000;
const NOW = 1_700_000_000_000; // arbitrary fixed "now" for determinism

test("default 1d window spans at least ~360 days before open, no reach clamp", () => {
  const openTime = NOW - 30 * DAY;
  const closeTime = NOW - 20 * DAY;
  const w = windowFor(openTime, closeTime, NOW, "1d");
  expect(w.res).toBe("1d");
  expect(w.resMs).toBe(DAY);
  expect(openTime - w.fromMs).toBeGreaterThanOrEqual(360 * DAY);
  expect(w.toMs).toBeGreaterThan(closeTime);
});

test("1h window: fromMs = open - 10d when open is recent", () => {
  const openTime = NOW - 5 * DAY;
  const w = windowFor(openTime, null, NOW, "1h");
  expect(w.resMs).toBe(3_600_000);
  expect(w.fromMs).toBe(openTime - 10 * DAY);
  expect(w.toMs).toBeGreaterThan(NOW); // open trade → end = now, plus pad
});

test("1h window: fromMs clamped to now - 720d when open is ~2 years ago", () => {
  const openTime = NOW - 2 * 365 * DAY;
  const w = windowFor(openTime, openTime + DAY, NOW, "1h");
  // unclamped would be open - 10d, far earlier than the 720-day reach limit
  expect(w.fromMs).toBe(NOW - 720 * DAY);
  expect(w.fromMs).toBeGreaterThan(openTime - 10 * DAY);
});

test("15m window: fromMs clamped to ~58 days reach", () => {
  const openTime = NOW - 100 * DAY;
  const w = windowFor(openTime, openTime + DAY, NOW, "15m");
  expect(w.resMs).toBe(900_000);
  expect(w.fromMs).toBe(NOW - 58 * DAY);
});

test("15m window: fromMs = open - 2d when well within reach", () => {
  const openTime = NOW - 3 * DAY;
  const w = windowFor(openTime, openTime + DAY, NOW, "15m");
  expect(w.fromMs).toBe(openTime - 2 * DAY);
});

test("open trade (closeTime null) uses now as the end for toMs padding", () => {
  const openTime = NOW - 5 * DAY;
  const dayRes = windowFor(openTime, null, NOW, "1d");
  const hourRes = windowFor(openTime, null, NOW, "1h");
  const fifteenRes = windowFor(openTime, null, NOW, "15m");
  expect(dayRes.toMs).toBeGreaterThanOrEqual(NOW + 2 * DAY);
  expect(hourRes.toMs).toBe(NOW + 2 * DAY);
  expect(fifteenRes.toMs).toBe(NOW + DAY);
});

test("focusFrom/focusTo bracket the trade window and sit inside [fromMs, toMs]", () => {
  for (const res of ["1d", "1h", "15m"] as const) {
    const openTime = NOW - 15 * DAY;
    const closeTime = NOW - 10 * DAY;
    const w = windowFor(openTime, closeTime, NOW, res);
    expect(w.focusFrom).toBeLessThanOrEqual(openTime);
    expect(w.focusTo).toBeGreaterThanOrEqual(closeTime);
    expect(w.focusFrom).toBeGreaterThanOrEqual(w.fromMs);
    expect(w.focusTo).toBeLessThanOrEqual(w.toMs);
  }
});

test("focus pad has a minimum even for a very short trade", () => {
  const openTime = NOW - 60_000; // 1 minute trade
  const closeTime = NOW;
  const w = windowFor(openTime, closeTime, NOW, "15m");
  expect(openTime - w.focusFrom).toBeGreaterThan(0);
  expect(w.focusTo - closeTime).toBeGreaterThan(0);
});

test("toMs default 1d pad has a floor for a short trade window", () => {
  const openTime = NOW - DAY;
  const closeTime = NOW;
  const w = windowFor(openTime, closeTime, NOW, "1d");
  expect(w.toMs - closeTime).toBeGreaterThanOrEqual(2 * DAY - 1); // ~2 day min pad
});
