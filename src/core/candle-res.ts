// Pure window/resolution policy for the trade-detail chart. Decides how much candle history to
// load (fromMs..toMs, clamped to what Yahoo actually retains at each intraday resolution) and what
// range the chart should show on first paint (focusFrom..focusTo), independent of the loaded window.

const DAY_MS = 86_400_000;

export type Res = "1d" | "1h" | "15m";

export interface CandleWindow {
  res: Res;
  resMs: number;
  fromMs: number;
  toMs: number;
  focusFrom: number;
  focusTo: number;
}

const RES_MS: Record<Res, number> = { "1d": DAY_MS, "1h": 3_600_000, "15m": 900_000 };

// Yahoo intraday retention, applied relative to `now` (not `openTime`) since it bounds how far
// back the API will serve data today, regardless of when the trade happened.
const REACH_MS: Partial<Record<Res, number>> = { "1h": 720 * DAY_MS, "15m": 58 * DAY_MS };

export function windowFor(openTime: number, closeTime: number | null, now: number, res: Res): CandleWindow {
  const resMs = RES_MS[res];
  const end = closeTime ?? now;
  const span = Math.max(end - openTime, 0);

  let fromMs: number;
  let toMs: number;
  if (res === "1d") {
    fromMs = openTime - 365 * DAY_MS;
    toMs = end + Math.max(span * 0.05, 2 * DAY_MS);
  } else if (res === "1h") {
    fromMs = openTime - 10 * DAY_MS;
    toMs = end + 2 * DAY_MS;
  } else {
    fromMs = openTime - 2 * DAY_MS;
    toMs = end + DAY_MS;
  }

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
