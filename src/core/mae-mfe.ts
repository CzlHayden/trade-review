import type { Candle, Trade } from "../domain/types";

/** Max adverse/favorable excursion in price points per share, from the trade's avgEntry. */
export function computeExcursion(
  trade: Trade,
  candles: Candle[],
): { mae: number | null; mfe: number | null } {
  const end = trade.closeTime ?? Number.POSITIVE_INFINITY;
  const inWindow = candles.filter((c) => c.time >= trade.openTime && c.time <= end);
  if (inWindow.length === 0) return { mae: null, mfe: null };

  let hi = Number.NEGATIVE_INFINITY;
  let lo = Number.POSITIVE_INFINITY;
  for (const c of inWindow) {
    if (c.high > hi) hi = c.high;
    if (c.low < lo) lo = c.low;
  }

  if (trade.direction === "LONG") {
    return { mfe: hi - trade.avgEntry, mae: trade.avgEntry - lo };
  }
  return { mfe: trade.avgEntry - lo, mae: hi - trade.avgEntry };
}
