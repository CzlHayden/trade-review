// Pure R-framed metrics for a single OPEN position. All dollar figures are in the position's own
// currency (never mixed); R is dimensionless (P&L ÷ the trade's initial dollar risk). The central idea
// is "if I get stopped at my current stop, what happens?" — a SIGNED outcome, from which open risk
// (the loss side) and locked-in profit (the gain side) both fall out. A stop at/above entry is a
// "free trade": zero open risk, positive locked profit — the case a plain |entry−stop| gets wrong.

export interface PositionMetricsInput {
  avgCost: number;
  qty: number; // signed: + long, − short
  price: number | null; // current market price (from the latest snapshot); null when unknown
  stop: number | null; // effective stop; null when none is known
  initialRisk: number | null; // 1R in the position's currency (the trade's initial dollar risk); null when unknown
}

export interface PositionMetrics {
  stopOutcome: number | null; // signed $ if stopped at the current stop: (stop − avgCost) × qty
  openRisk: number | null; // loss still exposed = max(0, −stopOutcome); 0 on a free trade; null with no stop
  lockedProfit: number | null; // guaranteed profit if stopped = max(0, stopOutcome)
  stopOutcomeR: number | null; // stopOutcome ÷ initialRisk (signed; ≥ 0 ⇒ free trade)
  unrealized: number | null; // paper P&L now: (price − avgCost) × qty
  unrealizedR: number | null; // unrealized ÷ initialRisk
  freeTrade: boolean; // a stop is set and it locks in ≥ breakeven (no downside left)
}

function perR(dollars: number | null, initialRisk: number | null): number | null {
  if (dollars === null || initialRisk === null || initialRisk <= 0) return null;
  return dollars / initialRisk;
}

export function positionMetrics(i: PositionMetricsInput): PositionMetrics {
  const stopOutcome = i.stop === null ? null : (i.stop - i.avgCost) * i.qty;
  const unrealized = i.price === null ? null : (i.price - i.avgCost) * i.qty;
  return {
    stopOutcome,
    openRisk: stopOutcome === null ? null : Math.max(0, -stopOutcome),
    lockedProfit: stopOutcome === null ? null : Math.max(0, stopOutcome),
    stopOutcomeR: perR(stopOutcome, i.initialRisk),
    unrealized,
    unrealizedR: perR(unrealized, i.initialRisk),
    freeTrade: stopOutcome !== null && stopOutcome >= 0,
  };
}
