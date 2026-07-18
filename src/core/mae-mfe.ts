import type { Candle, Trade } from "../domain/types";

/**
 * Max adverse/favorable excursion in price points per share, from the trade's avgEntry.
 *
 * `resolution` is the candle bar duration in ms; candle timestamps are bar-START times, so a bar
 * covers [time, time + resolution).
 *
 * Only bars FULLY inside the hold [openTime, end) count. A bar that STRADDLES either boundary would
 * fold in price the trade never experienced: the entry bar's high/low can predate the fill (you
 * bought after an early spike), and the exit bar's can postdate it (price kept moving after you were
 * out). Counting those over-states excursion — a real defect that mis-fired MFE-based flags (e.g. a
 * loss tagged "round-tripped a gain" off a spike that happened before entry). Instead the fills
 * themselves anchor the range: avgEntry is the price at openTime, avgExit at closeTime — both real
 * in-window points. They also yield a sane excursion for a trade too short to contain a whole bar.
 *
 * Returns nulls only when NO candles were supplied (a fetch failure), so the caller can keep any
 * previously-computed excursion rather than overwrite it with an anchors-only degrade. Both values >= 0.
 */
export function computeExcursion(
  trade: Trade,
  candles: Candle[],
  resolution: number,
): { mae: number | null; mfe: number | null } {
  if (candles.length === 0) return { mae: null, mfe: null };
  const end = trade.closeTime ?? Number.POSITIVE_INFINITY;
  // Bar [c.time, c.time + resolution) is fully inside [openTime, end): starts at/after open AND ends
  // at/before close. Straddling boundary bars (entry/exit bars) are dropped — the anchors cover them.
  const inside = candles.filter((c) => c.time >= trade.openTime && c.time + resolution <= end);

  // Anchor on the fills; avgExit is null only for an open trade (then avgEntry alone bounds it).
  let hi = Math.max(trade.avgEntry, trade.avgExit ?? trade.avgEntry);
  let lo = Math.min(trade.avgEntry, trade.avgExit ?? trade.avgEntry);
  for (const c of inside) {
    if (c.high > hi) hi = c.high;
    if (c.low < lo) lo = c.low;
  }

  const clamp = (n: number) => Math.max(0, n);
  if (trade.direction === "LONG") {
    return { mfe: clamp(hi - trade.avgEntry), mae: clamp(trade.avgEntry - lo) };
  }
  return { mfe: clamp(trade.avgEntry - lo), mae: clamp(hi - trade.avgEntry) };
}
