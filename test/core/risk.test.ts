import { test, expect } from "bun:test";
import { computeRisk } from "../../src/core/risk";
import { buildTrades } from "../../src/core/trade-builder";
import { fill, seedPos } from "../helpers";

function closedLong() {
  // BUY 100 @ 10, SELL 100 @ 12 → realizedPnl 200.
  return buildTrades([fill("BUY", 100, 10), fill("SELL", 100, 12)])[0]!;
}

function closedShort() {
  // SELL 100 @ 12, BUY 100 @ 10 → SHORT, entry 12, realizedPnl 200.
  return buildTrades([fill("SELL", 100, 12), fill("BUY", 100, 10)])[0]!;
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

test("seeded trade (coverage predates data) → null risk and R for an INFERRED stop", () => {
  // Pre-existing 100 @ 10, sold 100 @ 12. coverageOk=false → cost basis unreliable.
  const seeded = buildTrades([fill("SELL", 100, 12)], [seedPos(100, 10)])[0]!;
  expect(seeded.coverageOk).toBe(false);
  expect(computeRisk(seeded, 9)).toEqual({ risk: null, rMultiple: null });
});

test("seeded trade WITH an explicit manual stop is honored (user's escape hatch)", () => {
  const seeded = buildTrades([fill("SELL", 100, 12)], [seedPos(100, 10)])[0]!; // LONG, entry 10, pnl 200
  const r = computeRisk(seeded, 9, { manual: true }); // loss-side manual stop → risk 100 → 2R
  expect(r.risk).toBe(100);
  expect(r.rMultiple).toBe(2);
  // But a manual stop on the PROFIT side is still rejected (e.g. an un-split-adjusted number).
  expect(computeRisk(seeded, 11, { manual: true })).toEqual({ risk: null, rMultiple: null });
});

test("LONG stop on the profit side (above entry) → null, no fabricated risk", () => {
  const t = closedLong(); // entry 10
  expect(computeRisk(t, 12)).toEqual({ risk: null, rMultiple: null });
});

test("SHORT: stop above entry is protective (risk computed); below entry is fabricated (null)", () => {
  const t = closedShort(); // SHORT entry 12, pnl 200
  const ok = computeRisk(t, 13); // stop above entry → risk per share 1 × 100 = 100 → 2R
  expect(ok.risk).toBe(100);
  expect(ok.rMultiple).toBe(2);
  expect(computeRisk(t, 11)).toEqual({ risk: null, rMultiple: null }); // stop below entry → profit side
});
