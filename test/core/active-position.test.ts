import { test, expect } from "bun:test";
import { activePosition } from "../../src/core/active-position";

// A LONG: bought 10 @ 100, planned stop 90 → risk = |100−90|×10 = 100 (1R = $100, risk-per-share $10).
const LONG = { direction: "LONG" as const, avgEntry: 100, currentQty: 10, maxQty: 10, risk: 100 };

test("LONG in profit: open R (unrealized) and locked R (stop level)", () => {
  // price 110 → +$100 open = +1R. Stop trailed to 105 → sits (105−100)/10 = +0.5R off entry.
  const a = activePosition({ ...LONG, currentPrice: 110, effectiveStop: 105 });
  expect(a.openPnl).toBeCloseTo(100);
  expect(a.openR).toBeCloseTo(1);
  expect(a.lockedR).toBeCloseTo(0.5);
});

test("LONG in loss: negative open R; stop at the planned stop is −1R (full risk on)", () => {
  const a = activePosition({ ...LONG, currentPrice: 95, effectiveStop: 90 });
  expect(a.openR).toBeCloseTo(-0.5); // −$50 / $100
  expect(a.lockedR).toBeCloseTo(-1); // stop at the planned 90 → −1R
});

test("stop at breakeven locks 0R (no risk left)", () => {
  const a = activePosition({ ...LONG, currentPrice: 108, effectiveStop: 100 });
  expect(a.lockedR).toBeCloseTo(0);
});

test("stop moved a full R into profit locks +1R (guaranteed level)", () => {
  const a = activePosition({ ...LONG, currentPrice: 130, effectiveStop: 110 });
  expect(a.lockedR).toBeCloseTo(1); // (110−100)/10
});

test("SHORT is direction-correct: profit when price falls, stop below entry is in profit", () => {
  // Sold 10 @ 100 (qty −10), planned stop 110 → risk = 100. Price 90 → +$100 = +1R.
  const s = { direction: "SHORT" as const, avgEntry: 100, currentQty: -10, maxQty: 10, risk: 100 };
  const a = activePosition({ ...s, currentPrice: 90, effectiveStop: 95 });
  expect(a.openR).toBeCloseTo(1);
  // Stop at 95 (below entry = in profit for a short) → (95−100)×−1 / 10 = +0.5R.
  expect(a.lockedR).toBeCloseTo(0.5);
  // Stop at the planned 110 → −1R (full risk on).
  expect(activePosition({ ...s, currentPrice: 90, effectiveStop: 110 }).lockedR).toBeCloseTo(-1);
});

test("locked R is qty-independent: scaling out doesn't move the stop level, but open R shrinks", () => {
  // Hold only 4 of the original 10 (maxQty stays 10 — the risk basis). Stop still at 105.
  const a = activePosition({ ...LONG, currentQty: 4, currentPrice: 110, effectiveStop: 105 });
  expect(a.openPnl).toBeCloseTo(40); // (110−100)×4 — unrealized on the remaining shares
  expect(a.openR).toBeCloseTo(0.4);
  expect(a.lockedR).toBeCloseTo(0.5); // stop still sits at +0.5R off entry, regardless of holding
});

test("no risk basis: P&L still computed, both R figures null", () => {
  const a = activePosition({ ...LONG, risk: null, currentPrice: 110, effectiveStop: 105 });
  expect(a.openPnl).toBeCloseTo(100);
  expect(a.openR).toBeNull();
  expect(a.lockedR).toBeNull();
});

test("zero risk is treated as unknown (no divide-by-zero)", () => {
  const a = activePosition({ ...LONG, risk: 0, currentPrice: 110, effectiveStop: 105 });
  expect(a.openR).toBeNull();
  expect(a.lockedR).toBeNull();
});

test("no effective stop: locked R null, open R still computed", () => {
  const a = activePosition({ ...LONG, currentPrice: 110, effectiveStop: null });
  expect(a.openR).toBeCloseTo(1);
  expect(a.lockedR).toBeNull();
});
