// Pure R-framed metrics for a single OPEN position. All dollar figures are in the position's own
// currency (never mixed); R is dimensionless (P&L ÷ the trade's initial dollar risk). The central idea
// is "if I get stopped at my current stop, what happens?" — a SIGNED outcome, from which open risk
// (the loss side) and locked-in profit (the gain side) both fall out. Crucially this counts money
// ALREADY BANKED from partial exits (realizedSoFar): a runner whose remaining shares would stop out for
// a small loss can still be house money once the profit you took off the table is included. A stop
// at/above entry (or enough banked profit) is a "free trade": zero open risk, positive locked profit.

export interface PositionMetricsInput {
  avgCost: number;
  qty: number; // signed: + long, − short (the REMAINING shares)
  price: number | null; // current market price (from the latest snapshot); null when unknown
  stop: number | null; // effective stop; null when none is known
  initialRisk: number | null; // 1R in the position's currency (the trade's initial dollar risk); null when unknown
  realizedSoFar: number; // profit ALREADY BANKED from partial exits of this trade (0 when none); counts toward the cushion
}

export interface PositionMetrics {
  realizedSoFar: number; // banked profit passthrough (for display / the cushion breakdown)
  stopOutcome: number | null; // remaining shares only, if stopped: (stop − avgCost) × qty
  cushion: number | null; // TOTAL if stopped = realizedSoFar + stopOutcome (banked + remaining); null when no stop
  openRisk: number | null; // loss still exposed net of banked profit = max(0, −cushion); 0 on a free trade; null with no stop
  lockedProfit: number | null; // guaranteed profit if stopped = max(0, cushion)
  cushionR: number | null; // cushion ÷ initialRisk (signed; ≥ 0 ⇒ free trade)
  unrealized: number | null; // paper P&L on the remaining shares: (price − avgCost) × qty
  totalPnl: number | null; // whole trade so far = realizedSoFar + unrealized; null when price unknown
  totalPnlR: number | null; // totalPnl ÷ initialRisk
  freeTrade: boolean; // the cushion locks in ≥ breakeven (house money, banked profit included)
}

function perR(dollars: number | null, initialRisk: number | null): number | null {
  if (dollars === null || initialRisk === null || initialRisk <= 0) return null;
  return dollars / initialRisk;
}

export function positionMetrics(i: PositionMetricsInput): PositionMetrics {
  // Remaining shares only, if stopped at the current stop.
  const stopOutcome = i.stop === null ? null : (i.stop - i.avgCost) * i.qty;
  // The real cushion counts what's already banked — a stopped-out remainder can still be net green.
  const cushion = stopOutcome === null ? null : stopOutcome + i.realizedSoFar;
  const unrealized = i.price === null ? null : (i.price - i.avgCost) * i.qty;
  const totalPnl = unrealized === null ? null : unrealized + i.realizedSoFar;
  return {
    realizedSoFar: i.realizedSoFar,
    stopOutcome,
    cushion,
    openRisk: cushion === null ? null : Math.max(0, -cushion),
    lockedProfit: cushion === null ? null : Math.max(0, cushion),
    cushionR: perR(cushion, i.initialRisk),
    unrealized,
    totalPnl,
    totalPnlR: perR(totalPnl, i.initialRisk),
    freeTrade: cushion !== null && cushion >= 0,
  };
}
