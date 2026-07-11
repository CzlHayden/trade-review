import type { Trade } from "../domain/types";

const EPS = 1e-9;

/** Dollar risk and R-multiple for a trade given its (possibly null) stop price.
 *
 * Risk is the PLANNED risk: |entry − stop| × size, where `stop` is the initial planned stop
 * (caller passes `stop.initialStop`, or a manual override). R = realizedPnl / risk.
 *
 * Returns nulls (rather than a fabricated number) in three cases where risk is not meaningful:
 *  - no stop is known;
 *  - the trade is SEEDED (coverageOk=false): its cost basis predates our coverage, so the inferred
 *    stop is unreliable — stats already exclude these, so we don't surface a risk/R either. EXCEPTION:
 *    when `opts.manual` is set the user has asserted the stop explicitly (their escape hatch for a
 *    split/seed trade the tool can't reconstruct), so we honor it;
 *  - the stop sits on the PROFIT side of entry (LONG stop above entry / SHORT stop below). That is
 *    not a protective stop; taking Math.abs() would invent "risk" that was never at risk (this also
 *    neutralises split-corrupted stop prices, e.g. a pre-split trigger against a post-split entry).
 *    This guard applies even to a manual stop — an un-split-adjusted number can't produce a real R.
 */
export function computeRisk(
  trade: Trade,
  stop: number | null,
  opts: { manual?: boolean } = {},
): { risk: number | null; rMultiple: number | null } {
  if (stop === null) return { risk: null, rMultiple: null };
  if (!trade.coverageOk && !opts.manual) return { risk: null, rMultiple: null };

  const onProfitSide = trade.direction === "LONG" ? stop > trade.avgEntry : stop < trade.avgEntry;
  if (onProfitSide) return { risk: null, rMultiple: null };

  const risk = Math.abs(trade.avgEntry - stop) * trade.maxQty;

  let rMultiple: number | null = null;
  if (trade.status === "closed" && trade.realizedPnl !== null && risk > EPS) {
    rMultiple = trade.realizedPnl / risk;
  }
  return { risk, rMultiple };
}
