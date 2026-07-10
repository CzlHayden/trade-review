import { test, expect } from "bun:test";
import { computeRisk } from "../../src/core/risk";
import { buildTrades } from "../../src/core/trade-builder";
import { fill } from "../helpers";

function closedLong() {
  // BUY 100 @ 10, SELL 100 @ 12 → realizedPnl 200.
  return buildTrades([fill("BUY", 100, 10), fill("SELL", 100, 12)])[0]!;
}

test("risk = |entry - stop| * maxQty; R = pnl / risk", () => {
  const t = closedLong();
  const r = computeRisk(t, 9); // risk per share = 1, size 100 → risk 100; pnl 200 → 2R
  expect(r.risk).toBe(100);
  expect(r.rMultiple).toBe(2);
});

test("null stop → null risk and null R", () => {
  const t = closedLong();
  expect(computeRisk(t, null)).toEqual({ risk: null, rMultiple: null });
});

test("open trade → risk computed but R is null (no realized pnl)", () => {
  const openT = buildTrades([fill("BUY", 100, 10)])[0]!;
  const r = computeRisk(openT, 9);
  expect(r.risk).toBe(100);
  expect(r.rMultiple).toBeNull();
});

test("zero risk (stop equals entry) → null R, not Infinity", () => {
  const t = closedLong();
  const r = computeRisk(t, 10);
  expect(r.risk).toBe(0);
  expect(r.rMultiple).toBeNull();
});
