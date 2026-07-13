import { test, expect } from "bun:test";
import { positionMetrics } from "../../src/core/position-metrics";

// A long at 100, 10 shares, initial risk $50 (1R = $50, i.e. initial stop was 95).
const LONG = { avgCost: 100, qty: 10, price: 110, stop: 95, initialRisk: 50 };

test("long, stop below entry: open risk is the loss to the stop; not free", () => {
  const m = positionMetrics(LONG);
  expect(m.stopOutcome).toBe(-50); // (95-100)*10
  expect(m.openRisk).toBe(50);
  expect(m.lockedProfit).toBe(0);
  expect(m.stopOutcomeR).toBe(-1); // -50 / 50
  expect(m.freeTrade).toBe(false);
});

test("long, stop ABOVE entry: zero open risk, locked profit, free trade (the SNOW case)", () => {
  const m = positionMetrics({ ...LONG, stop: 103 });
  expect(m.stopOutcome).toBe(30); // (103-100)*10
  expect(m.openRisk).toBe(0); // <-- the bug fix: no risk, it's locked profit
  expect(m.lockedProfit).toBe(30);
  expect(m.stopOutcomeR).toBeCloseTo(0.6, 10); // 30 / 50
  expect(m.freeTrade).toBe(true);
});

test("long, stop exactly at entry: breakeven → free trade, zero risk, zero locked", () => {
  const m = positionMetrics({ ...LONG, stop: 100 });
  expect(m.stopOutcome).toBe(0);
  expect(m.openRisk).toBe(0);
  expect(m.lockedProfit).toBe(0);
  expect(m.freeTrade).toBe(true);
});

test("unrealized P&L and R from the current price", () => {
  const m = positionMetrics(LONG); // price 110
  expect(m.unrealized).toBe(100); // (110-100)*10
  expect(m.unrealizedR).toBe(2); // 100 / 50
});

test("short, stop above entry: at risk; stop below entry: locked profit (direction via signed qty)", () => {
  const short = { avgCost: 100, qty: -10, price: 90, stop: 105, initialRisk: 50 };
  const atRisk = positionMetrics(short);
  expect(atRisk.stopOutcome).toBe(-50); // (105-100)*-10
  expect(atRisk.openRisk).toBe(50);
  expect(atRisk.freeTrade).toBe(false);
  expect(atRisk.unrealized).toBe(100); // (90-100)*-10 → short profits as price falls
  expect(atRisk.unrealizedR).toBe(2);

  const locked = positionMetrics({ ...short, stop: 95 });
  expect(locked.stopOutcome).toBe(50); // (95-100)*-10
  expect(locked.openRisk).toBe(0);
  expect(locked.lockedProfit).toBe(50);
  expect(locked.freeTrade).toBe(true);
});

test("no stop → risk/outcome unknown (null), never zero; not a free trade", () => {
  const m = positionMetrics({ ...LONG, stop: null });
  expect(m.stopOutcome).toBe(null);
  expect(m.openRisk).toBe(null);
  expect(m.lockedProfit).toBe(null);
  expect(m.stopOutcomeR).toBe(null);
  expect(m.freeTrade).toBe(false);
  // unrealized still computable from price
  expect(m.unrealized).toBe(100);
});

test("no current price → unrealized null, but stop-based metrics still computed", () => {
  const m = positionMetrics({ ...LONG, price: null });
  expect(m.unrealized).toBe(null);
  expect(m.unrealizedR).toBe(null);
  expect(m.openRisk).toBe(50);
});

test("unknown initial risk → R fields null, dollar fields still present", () => {
  const m = positionMetrics({ ...LONG, initialRisk: null });
  expect(m.stopOutcomeR).toBe(null);
  expect(m.unrealizedR).toBe(null);
  expect(m.openRisk).toBe(50);
  expect(m.unrealized).toBe(100);
});
