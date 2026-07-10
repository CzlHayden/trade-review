import type { Candle, Trade } from "../domain/types";

/**
 * Max adverse/favorable excursion in price points per share, from the trade's avgEntry.
 * `resolution` is the candle bar duration in ms — needed because candle timestamps are
 * bar-START times, so a bar covers [time, time + resolution). A bar counts if that interval
 * overlaps the trade window [openTime, closeTime); this keeps the entry-bar (whose start is
 * before openTime) and drops a bar starting exactly at/after the exit. Both values are >= 0.
 */
export function computeExcursion(
  trade: Trade,
  candles: Candle[],
  resolution: number,
): { mae: number | null; mfe: number | null } {
  const end = trade.closeTime ?? Number.POSITIVE_INFINITY;
  // Bar [c.time, c.time + resolution) overlaps [openTime, end): ends after open AND starts before end.
  const inWindow = candles.filter((c) => c.time + resolution > trade.openTime && c.time < end);
  if (inWindow.length === 0) return { mae: null, mfe: null };

  let hi = Number.NEGATIVE_INFINITY;
  let lo = Number.POSITIVE_INFINITY;
  for (const c of inWindow) {
    if (c.high > hi) hi = c.high;
    if (c.low < lo) lo = c.low;
  }

  const clamp = (n: number) => Math.max(0, n);
  if (trade.direction === "LONG") {
    return { mfe: clamp(hi - trade.avgEntry), mae: clamp(trade.avgEntry - lo) };
  }
  return { mfe: clamp(trade.avgEntry - lo), mae: clamp(hi - trade.avgEntry) };
}
