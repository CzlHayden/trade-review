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

test("open trade (closeTime null) ends at now + the resolution's forward window", () => {
  const openTime = NOW - 5 * DAY;
  // end = now for an open trade, so toMs = now + FORWARD_MS[res] (span*0.5 is smaller here).
  expect(windowFor(openTime, null, NOW, "1d").toMs).toBe(NOW + 90 * DAY);
  expect(windowFor(openTime, null, NOW, "1h").toMs).toBe(NOW + 20 * DAY);
  expect(windowFor(openTime, null, NOW, "15m").toMs).toBe(NOW + 4 * DAY);
});

test("closed trade loads a bounded block of post-trade context; the initial view stays on the trade", () => {
  const openTime = NOW - 40 * DAY;
  const closeTime = NOW - 30 * DAY;
  for (const res of ["1d", "1wk", "1mo", "3mo"] as const) {
    const w = windowFor(openTime, closeTime, NOW, res);
    expect(w.toMs).toBeGreaterThan(closeTime + 20 * DAY); // real post-trade context, not a couple of bars
    expect(w.focusTo).toBeGreaterThanOrEqual(closeTime); // first paint still brackets the trade…
    expect(w.focusTo).toBeLessThan(w.toMs); // …not the far end of the loaded window
  }
});

test("closed intraday trade loads forward post-trade context too", () => {
  const openTime = NOW - 5 * DAY;
  const closeTime = NOW - 4 * DAY;
  for (const res of ["1h", "15m"] as const) {
    const w = windowFor(openTime, closeTime, NOW, res);
    expect(w.toMs).toBeGreaterThan(closeTime + 2 * DAY);
    expect(w.focusTo).toBeGreaterThanOrEqual(closeTime);
  }
});

test("an old closed trade's forward window stays historical (below now) so the cache serves it offline", () => {
  const openTime = NOW - 400 * DAY;
  const closeTime = NOW - 380 * DAY;
  const w = windowFor(openTime, closeTime, NOW, "1d");
  expect(w.toMs).toBeLessThan(NOW); // fully in the past → fully cacheable, no refetch, renders offline
  expect(w.toMs).toBeGreaterThan(closeTime); // and still shows post-trade context
});

test("a trade older than the intraday reach collapses to an empty window (route then coarsens to 1d)", () => {
  const openTime = NOW - 800 * DAY;
  const closeTime = NOW - 799 * DAY;
  for (const res of ["1h", "15m"] as const) {
    const w = windowFor(openTime, closeTime, NOW, res);
    expect(w.toMs).toBe(w.fromMs); // collapsed — NOT a 720d/58d window of unrelated recent bars
    expect(w.focusFrom).toBe(w.focusTo);
  }
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

test("never inverts the window: a trade older than the intraday reach collapses, not fromMs>toMs", () => {
  // Trade fully older than 1h reach (~720d): openTime 800d ago, closed 799d ago.
  const openTime = NOW - 800 * DAY;
  const closeTime = NOW - 799 * DAY;
  for (const res of ["1h", "15m"] as const) {
    const w = windowFor(openTime, closeTime, NOW, res);
    expect(w.fromMs).toBeLessThanOrEqual(w.toMs); // invariant: never inverted
    expect(w.focusFrom).toBeLessThanOrEqual(w.focusTo);
    expect(w.focusFrom).toBeGreaterThanOrEqual(w.fromMs);
    expect(w.focusTo).toBeLessThanOrEqual(w.toMs);
  }
});

test("higher timeframes load years of context and never reach-clamp", () => {
  const YEAR = 365 * DAY;
  const openTime = NOW - 100 * DAY;
  const closeTime = NOW - 80 * DAY;
  const cases: Array<{ res: "1wk" | "1mo" | "3mo"; resMs: number; minLookbackYears: number }> = [
    { res: "1wk", resMs: 7 * DAY, minLookbackYears: 3 },
    { res: "1mo", resMs: 30 * DAY, minLookbackYears: 10 },
    { res: "3mo", resMs: 91 * DAY, minLookbackYears: 25 },
  ];
  for (const { res, resMs, minLookbackYears } of cases) {
    const w = windowFor(openTime, closeTime, NOW, res);
    expect(w.res).toBe(res);
    expect(w.resMs).toBe(resMs);
    // Loads the full multi-year lookback (no reach clamp on weekly/monthly/quarterly).
    expect(openTime - w.fromMs).toBeGreaterThanOrEqual(minLookbackYears * YEAR - 1);
    // Focus still brackets the trade, and the window is never inverted.
    expect(w.focusFrom).toBeLessThanOrEqual(openTime);
    expect(w.focusTo).toBeGreaterThanOrEqual(closeTime);
    expect(w.fromMs).toBeLessThanOrEqual(w.toMs);
  }
});
