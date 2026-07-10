import type { Trade } from "../domain/types";

const EPS = 1e-9;

/** Dollar risk and R-multiple for a trade given its (possibly null) stop price. */
export function computeRisk(
  trade: Trade,
  stop: number | null,
): { risk: number | null; rMultiple: number | null } {
  if (stop === null) return { risk: null, rMultiple: null };

  const risk = Math.abs(trade.avgEntry - stop) * trade.maxQty;

  let rMultiple: number | null = null;
  if (trade.status === "closed" && trade.realizedPnl !== null && risk > EPS) {
    rMultiple = trade.realizedPnl / risk;
  }
  return { risk, rMultiple };
}
