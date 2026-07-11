// Pure window/resolution policy for the trade-detail chart. Decides how much candle history to
// load (fromMs..toMs, clamped to what Yahoo actually retains at each intraday resolution) and what
// range the chart should show on first paint (focusFrom..focusTo), independent of the loaded window.

const DAY_MS = 86_400_000;

export type Res = "15m" | "1h" | "1d" | "1wk" | "1mo" | "3mo";

export interface CandleWindow {
  res: Res;
  resMs: number;
  fromMs: number;
  toMs: number;
  focusFrom: number;
  focusTo: number;
}

const YEAR_MS = 365 * DAY_MS;

// Nominal bar duration per resolution (weekly/monthly/quarterly are approximate — only used to pick
// the Yahoo interval and to report resMs to the client).
const RES_MS: Record<Res, number> = {
  "15m": 900_000,
  "1h": 3_600_000,
  "1d": DAY_MS,
  "1wk": 7 * DAY_MS,
  "1mo": 30 * DAY_MS,
  "3mo": 91 * DAY_MS,
};

// How much history to load BEFORE the trade opens, per resolution. Coarser resolutions pull years of
// context (Yahoo serves long daily/weekly/monthly history for free) so the run-up into the entry is
// reviewable at every zoom level.
const LOOKBACK_MS: Record<Res, number> = {
  "15m": 2 * DAY_MS,
  "1h": 10 * DAY_MS,
  "1d": YEAR_MS,
  "1wk": 3 * YEAR_MS,
  "1mo": 10 * YEAR_MS,
  "3mo": 25 * YEAR_MS,
};

// Minimum pad AFTER the trade closes (a few bars of breathing room), per resolution.
const MIN_TAIL_MS: Record<Res, number> = {
  "15m": DAY_MS,
  "1h": 2 * DAY_MS,
  "1d": 2 * DAY_MS,
  "1wk": 7 * DAY_MS,
  "1mo": 30 * DAY_MS,
  "3mo": 91 * DAY_MS,
};

// Yahoo intraday retention, applied relative to `now` (not `openTime`) since it bounds how far
// back the API will serve data today, regardless of when the trade happened. Daily and coarser have
// effectively unbounded history, so no reach limit.
const REACH_MS: Partial<Record<Res, number>> = { "1h": 720 * DAY_MS, "15m": 58 * DAY_MS };

export function windowFor(openTime: number, closeTime: number | null, now: number, res: Res): CandleWindow {
  const resMs = RES_MS[res];
  const end = closeTime ?? now;
  const span = Math.max(end - openTime, 0);

  let fromMs = openTime - LOOKBACK_MS[res];
  let toMs = end + Math.max(span * 0.05, MIN_TAIL_MS[res]);

  const reach = REACH_MS[res];
  if (reach !== undefined) fromMs = Math.max(fromMs, now - reach);
  // A trade entirely older than the intraday reach clamps fromMs forward past toMs; collapse rather
  // than invert (the route's coarsen-on-empty ladder then falls back to 1d, which has no reach limit).
  if (fromMs > toMs) toMs = fromMs;

  const focusPad = Math.max(span * 0.1, DAY_MS);
  // Clamped into [fromMs, toMs]: the initial visible range can never exceed the loaded data.
  let focusFrom = Math.max(openTime - focusPad, fromMs);
  let focusTo = Math.min(end + focusPad, toMs);
  // A trade entirely older than the resolution's reach leaves `end` before `fromMs`, so the clamps
  // above can cross (focusFrom pinned up to fromMs, focusTo pinned down to toMs<focusFrom). Collapse
  // to the newest loaded edge rather than hand back an inverted range.
  if (focusFrom > focusTo) focusFrom = focusTo = toMs;

  return { res, resMs, fromMs, toMs, focusFrom, focusTo };
}
