// Pure math for the Daily market heatmap: turn one symbol's DAILY candle series into the four
// percentages the page shows (mirroring a classic daily-plan sheet): % day change, % 5-day change,
// % off the 52-week high, and % YTD. No I/O — candle fetching lives in the API layer.
import type { Candle } from "../domain/types";

export interface HeatmapMetrics {
  last: number | null; // latest close (null when the series is empty)
  dayPct: number | null; // last close vs previous session's close
  p5dPct: number | null; // last close vs the close 5 SESSIONS earlier (bars, not calendar days)
  off52wPct: number | null; // last close vs the max HIGH over the trailing 365 calendar days (≤ 0)
  ytdPct: number | null; // last close vs the final close of the previous calendar year
}

const EMPTY: HeatmapMetrics = { last: null, dayPct: null, p5dPct: null, off52wPct: null, ytdPct: null };

const YEAR_MS = 365 * 86_400_000;

function pctFrom(base: number | undefined, last: number): number | null {
  return base !== undefined && base > 0 ? last / base - 1 : null;
}

/** Compute the heatmap row from ascending daily candles. Every metric degrades to null when its
 * baseline isn't in the series (new listing, short fetch window) — never a throw, never a fake 0.
 * The YTD baseline is the LAST bar strictly before Jan 1 (UTC) of the latest bar's year, the common
 * "close of prior year" convention; a symbol listed this year has no such bar → null. */
export function heatmapMetrics(candles: Candle[]): HeatmapMetrics {
  if (candles.length === 0) return EMPTY;
  const bars = candles.slice().sort((a, b) => a.time - b.time);
  const lastBar = bars[bars.length - 1]!;
  const last = lastBar.close;

  const dayPct = pctFrom(bars[bars.length - 2]?.close, last);
  const p5dPct = pctFrom(bars[bars.length - 6]?.close, last);

  // 52-week high: intraday highs (not closes) over the trailing 365 calendar days, INCLUDING today's
  // own high — so a fresh breakout correctly reads ~0% off high, not a positive %.
  let hi = 0;
  for (const b of bars) {
    if (b.time >= lastBar.time - YEAR_MS && b.high > hi) hi = b.high;
  }
  const off52wPct = hi > 0 ? last / hi - 1 : null;

  const jan1 = Date.UTC(new Date(lastBar.time).getUTCFullYear(), 0, 1);
  let prevYearClose: number | undefined;
  for (const b of bars) {
    if (b.time < jan1) prevYearClose = b.close;
    else break;
  }
  const ytdPct = pctFrom(prevYearClose, last);

  return { last, dayPct, p5dPct, off52wPct, ytdPct };
}
