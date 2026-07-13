import { test, expect } from "bun:test";
import { positionMetrics } from "../../src/core/position-metrics";

// A long at 100, 10 shares, initial risk $50 (1R = $50, i.e. initial stop was 95). Nothing banked yet.
const LONG = { avgCost: 100, qty: 10, price: 110, stop: 95, initialRisk: 50, realizedSoFar: 0 };

test("long, stop below entry, nothing banked: open risk is the loss to the stop; not free", () => {
  const m = positionMetrics(LONG);
  expect(m.stopOutcome).toBe(-50); // (95-100)*10
  expect(m.cushion).toBe(-50); // nothing banked → cushion == remaining outcome
  expect(m.openRisk).toBe(50);
  expect(m.lockedProfit).toBe(0);
  expect(m.cushionR).toBe(-1); // -50 / 50
  expect(m.freeTrade).toBe(false);
});

test("long, stop ABOVE entry: zero open risk, locked profit, free trade (the SNOW case)", () => {
  const m = positionMetrics({ ...LONG, stop: 103 });
  expect(m.stopOutcome).toBe(30); // (103-100)*10
  expect(m.cushion).toBe(30);
  expect(m.openRisk).toBe(0); // <-- the original bug fix: no risk, it's locked profit
  expect(m.lockedProfit).toBe(30);
  expect(m.cushionR).toBeCloseTo(0.6, 10); // 30 / 50
  expect(m.freeTrade).toBe(true);
});

test("BANKED profit turns a losing remainder into a free trade (house money)", () => {
  // Bought 10 @ 100, sold 4 @ 130 (banked +120), holding 6 with a stop at 95. The remaining 6 alone
  // would stop out for −30, but +120 is already in the bank → net +90 guaranteed: a free trade.
  const m = positionMetrics({ avgCost: 100, qty: 6, price: 140, stop: 95, initialRisk: 50, realizedSoFar: 120 });
  expect(m.stopOutcome).toBe(-30); // remaining only: (95-100)*6
  expect(m.cushion).toBe(90); // -30 + 120 banked
  expect(m.openRisk).toBe(0); // house money → no real downside left
  expect(m.lockedProfit).toBe(90);
  expect(m.cushionR).toBeCloseTo(1.8, 10); // 90 / 50
  expect(m.freeTrade).toBe(true);
});

test("banked profit that doesn't fully cover the remaining loss: risk is the NET, not the gross", () => {
  // Banked +10, but the remaining would lose −50 → still −40 exposed (not −50, and not free).
  const m = positionMetrics({ avgCost: 100, qty: 10, price: 105, stop: 95, initialRisk: 50, realizedSoFar: 10 });
  expect(m.stopOutcome).toBe(-50);
  expect(m.cushion).toBe(-40); // -50 + 10 banked
  expect(m.openRisk).toBe(40); // net loss exposed, reduced by the banked profit
  expect(m.freeTrade).toBe(false);
  expect(m.cushionR).toBeCloseTo(-0.8, 10); // -40 / 50
});

test("total P&L so far = banked realized + unrealized on the remaining shares", () => {
  // Banked +120; remaining 6 marked at 140 → unrealized (140-100)*6 = 240; total = 360.
  const m = positionMetrics({ avgCost: 100, qty: 6, price: 140, stop: 95, initialRisk: 50, realizedSoFar: 120 });
  expect(m.unrealized).toBe(240); // remaining shares only
  expect(m.totalPnl).toBe(360); // 240 + 120 banked
  expect(m.totalPnlR).toBeCloseTo(7.2, 10); // 360 / 50
});

test("long, stop exactly at entry, nothing banked: breakeven → free trade, zero risk, zero locked", () => {
  const m = positionMetrics({ ...LONG, stop: 100 });
  expect(m.cushion).toBe(0);
  expect(m.openRisk).toBe(0);
  expect(m.lockedProfit).toBe(0);
  expect(m.freeTrade).toBe(true);
});

test("unrealized/total P&L and R from the current price (nothing banked)", () => {
  const m = positionMetrics(LONG); // price 110, realizedSoFar 0
  expect(m.unrealized).toBe(100); // (110-100)*10
  expect(m.totalPnl).toBe(100); // + 0 banked
  expect(m.totalPnlR).toBe(2); // 100 / 50
});

test("short, stop above entry: at risk; stop below entry: locked profit (direction via signed qty)", () => {
  const short = { avgCost: 100, qty: -10, price: 90, stop: 105, initialRisk: 50, realizedSoFar: 0 };
  const atRisk = positionMetrics(short);
  expect(atRisk.stopOutcome).toBe(-50); // (105-100)*-10
  expect(atRisk.openRisk).toBe(50);
  expect(atRisk.freeTrade).toBe(false);
  expect(atRisk.unrealized).toBe(100); // (90-100)*-10 → short profits as price falls
  expect(atRisk.totalPnlR).toBe(2);

  const locked = positionMetrics({ ...short, stop: 95 });
  expect(locked.stopOutcome).toBe(50); // (95-100)*-10
  expect(locked.openRisk).toBe(0);
  expect(locked.lockedProfit).toBe(50);
  expect(locked.freeTrade).toBe(true);
});

test("no stop → cushion/risk unknown (null), never zero; not a free trade", () => {
  const m = positionMetrics({ ...LONG, stop: null });
  expect(m.stopOutcome).toBe(null);
  expect(m.cushion).toBe(null);
  expect(m.openRisk).toBe(null);
  expect(m.lockedProfit).toBe(null);
  expect(m.cushionR).toBe(null);
  expect(m.freeTrade).toBe(false);
  // total P&L still computable from price + banked
  expect(m.unrealized).toBe(100);
  expect(m.totalPnl).toBe(100);
});

test("no current price → unrealized/total null, but stop-based cushion still computed", () => {
  const m = positionMetrics({ ...LONG, price: null });
  expect(m.unrealized).toBe(null);
  expect(m.totalPnl).toBe(null);
  expect(m.totalPnlR).toBe(null);
  expect(m.openRisk).toBe(50);
});

test("unknown initial risk → R fields null, dollar fields still present", () => {
  const m = positionMetrics({ ...LONG, initialRisk: null });
  expect(m.cushionR).toBe(null);
  expect(m.totalPnlR).toBe(null);
  expect(m.openRisk).toBe(50);
  expect(m.unrealized).toBe(100);
});
