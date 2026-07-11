import { test, expect } from "bun:test";
import { activePosition, stopStillAtRisk } from "../../src/core/active-position";

// A LONG: bought 10 @ 100, planned stop 90 → risk = |100−90|×10 = 100 (1R = $100).
const LONG = { direction: "LONG" as const, avgEntry: 100, currentQty: 10, risk: 100 };

test("LONG in profit: open R and locked R at the current stop", () => {
  // price 110 → +$100 open = +1R. Stop trailed to 105 → locks (105−100)×10 = +$50 = +0.5R.
  const a = activePosition({ ...LONG, currentPrice: 110, effectiveStop: 105 });
  expect(a.openPnl).toBeCloseTo(100);
  expect(a.openR).toBeCloseTo(1);
  expect(a.lockedPnl).toBeCloseTo(50);
  expect(a.lockedR).toBeCloseTo(0.5);
});

test("LONG in loss: negative open R, stop below entry still exposes the full R", () => {
  const a = activePosition({ ...LONG, currentPrice: 95, effectiveStop: 90 });
  expect(a.openR).toBeCloseTo(-0.5); // −$50 / $100
  expect(a.lockedR).toBeCloseTo(-1); // stop at the planned 90 → −1R locked (full risk on)
});

test("stop at breakeven locks 0R (no risk left)", () => {
  const a = activePosition({ ...LONG, currentPrice: 108, effectiveStop: 100 });
  expect(a.lockedR).toBeCloseTo(0);
  expect(a.lockedPnl).toBeCloseTo(0);
});

test("stop moved a full R into profit locks +1R (guaranteed)", () => {
  const a = activePosition({ ...LONG, currentPrice: 130, effectiveStop: 110 });
  expect(a.lockedR).toBeCloseTo(1); // (110−100)×10 = +$100 = +1R
});

test("SHORT is direction-correct: profit when price falls", () => {
  // Sold 10 @ 100 (qty −10), planned stop 110 → risk = 100. Price 90 → +$100 = +1R.
  const s = { direction: "SHORT" as const, avgEntry: 100, currentQty: -10, risk: 100 };
  const a = activePosition({ ...s, currentPrice: 90, effectiveStop: 95 });
  expect(a.openR).toBeCloseTo(1);
  // Stop at 95 (below entry, i.e. in profit for a short) → locks (95−100)×−10 = +$50 = +0.5R.
  expect(a.lockedR).toBeCloseTo(0.5);
});

test("scaled-out holding reports R on the remaining shares only", () => {
  // Same 100/90 basis but only 4 shares still held → R normalizes by the same planned 1R=$100.
  const a = activePosition({ ...LONG, currentQty: 4, currentPrice: 110, effectiveStop: 105 });
  expect(a.openPnl).toBeCloseTo(40); // (110−100)×4
  expect(a.openR).toBeCloseTo(0.4);
  expect(a.lockedR).toBeCloseTo(0.2); // (105−100)×4 / 100
});

test("no risk basis: P&L still computed, R is null", () => {
  const a = activePosition({ ...LONG, risk: null, currentPrice: 110, effectiveStop: 105 });
  expect(a.openPnl).toBeCloseTo(100);
  expect(a.openR).toBeNull();
  expect(a.lockedPnl).toBeCloseTo(50); // locked P&L is still meaningful without a risk basis
  expect(a.lockedR).toBeNull();
});

test("zero risk is treated as unknown (no divide-by-zero)", () => {
  const a = activePosition({ ...LONG, risk: 0, currentPrice: 110, effectiveStop: 105 });
  expect(a.openR).toBeNull();
  expect(a.lockedR).toBeNull();
});

test("no effective stop: locked figures are null, open R still computed", () => {
  const a = activePosition({ ...LONG, currentPrice: 110, effectiveStop: null });
  expect(a.openR).toBeCloseTo(1);
  expect(a.lockedPnl).toBeNull();
  expect(a.lockedR).toBeNull();
});

test("stopStillAtRisk distinguishes protective stops from profit-side stops", () => {
  expect(stopStillAtRisk("LONG", 100, 90)).toBe(true); // below entry → still risking
  expect(stopStillAtRisk("LONG", 100, 105)).toBe(false); // above entry → in profit
  expect(stopStillAtRisk("SHORT", 100, 110)).toBe(true); // above entry → still risking
  expect(stopStillAtRisk("SHORT", 100, 95)).toBe(false); // below entry → in profit
});
