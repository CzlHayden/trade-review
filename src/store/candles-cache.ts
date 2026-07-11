import type { Database } from "bun:sqlite";
import type { CandleSource } from "../domain/ports";
import type { Candle } from "../domain/types";

const TAIL_MS = 2 * 86_400_000; // last ~2 days may be partial/backfilled → refetch (on top of resMs)

export interface CacheOpts {
  /** Current epoch ms. Pass a FUNCTION in a long-lived server so `nearNow`/coverage stay live across
   * syncs; a fixed number is fine for one-shot/tests. */
  now: number | (() => number);
}

function readBars(db: Database, symbol: string, resMs: number, from: number, to: number): Candle[] {
  return (
    db
      .query(
        `SELECT time, open, high, low, close, volume FROM candles_cache
         WHERE symbol=? AND res_ms=? AND time>=? AND time<=? ORDER BY time ASC`,
      )
      .all(symbol, resMs, from, to) as any[]
  ).map((r) => ({
    time: r.time,
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    volume: r.volume,
  }));
}

function writeBars(db: Database, symbol: string, resMs: number, candles: Candle[]): void {
  const stmt = db.prepare(
    `INSERT INTO candles_cache (symbol, res_ms, time, open, high, low, close, volume)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(symbol,res_ms,time) DO UPDATE SET
       open=excluded.open, high=excluded.high, low=excluded.low, close=excluded.close, volume=excluded.volume`,
  );
  db.transaction(() => {
    for (const c of candles) stmt.run(symbol, resMs, c.time, c.open, c.high, c.low, c.close, c.volume);
  })();
}

interface Interval {
  from_ms: number;
  to_ms: number;
}

function intervals(db: Database, symbol: string, resMs: number): Interval[] {
  return db
    .query(`SELECT from_ms, to_ms FROM candle_coverage WHERE symbol=? AND res_ms=? ORDER BY from_ms ASC`)
    .all(symbol, resMs) as Interval[];
}

/** True when a SINGLE stored interval fully contains [from, to]. A request spanning a gap between
 * two disjoint intervals is intentionally not covered → it refetches. */
function isCovered(ivs: Interval[], from: number, to: number): boolean {
  return ivs.some((iv) => iv.from_ms <= from && iv.to_ms >= to);
}

/** Merge [from, to] into the stored intervals: union it with every overlapping/adjacent interval,
 * delete those, and insert the single union. Disjoint intervals are preserved as separate rows. */
function addCoverage(db: Database, symbol: string, resMs: number, from: number, to: number, at: number): void {
  const ivs = intervals(db, symbol, resMs);
  let lo = from;
  let hi = to;
  const merged: number[] = [];
  for (const iv of ivs) {
    if (iv.from_ms <= hi && iv.to_ms >= lo) {
      // overlap or touch
      lo = Math.min(lo, iv.from_ms);
      hi = Math.max(hi, iv.to_ms);
      merged.push(iv.from_ms);
    }
  }
  const del = db.prepare(`DELETE FROM candle_coverage WHERE symbol=? AND res_ms=? AND from_ms=?`);
  const ins = db.prepare(
    `INSERT INTO candle_coverage (symbol,res_ms,from_ms,to_ms,fetched_at) VALUES (?,?,?,?,?)
     ON CONFLICT(symbol,res_ms,from_ms) DO UPDATE SET to_ms=excluded.to_ms, fetched_at=excluded.fetched_at`,
  );
  db.transaction(() => {
    for (const f of merged) del.run(symbol, resMs, f);
    ins.run(symbol, resMs, lo, hi, at);
  })();
}

/**
 * Wrap a CandleSource so bars fetched once are cached. Closed bars are immutable; only a range whose
 * end is within TAIL_MS of `now` refetches (the last bar is partial and the source backfills). On a
 * source failure/empty response the cache serves the request ONLY if a stored interval fully covers
 * it — a partially-covered range degrades to [] so a wrong window never reaches MAE/MFE. Coverage is
 * multi-interval, so two disjoint fetched windows both stay served.
 */
export function cachedCandles(db: Database, source: CandleSource, opts: CacheOpts): CandleSource {
  return {
    async getCandles(symbol, fromMs, toMs, resMs) {
      const now = typeof opts.now === "function" ? opts.now() : opts.now;
      const ivs = intervals(db, symbol, resMs);
      const covered = isCovered(ivs, fromMs, toMs);
      // A bar starting at `t` isn't closed until `t + resMs <= now`, so the partial-bar tail is one
      // bar-width PLUS the fixed TAIL margin. This matters for weekly/monthly/quarterly, where a bar
      // stays in progress for up to 7/30/91 days — a fixed 2-day tail would cache a partial coarse bar
      // and serve it frozen forever.
      const closedBefore = now - TAIL_MS - resMs;
      const nearNow = toMs >= closedBefore;
      if (covered && !nearNow) return readBars(db, symbol, resMs, fromMs, toMs);

      // Fetch only what's missing. When the closed prefix [fromMs, closedBefore] is already cached,
      // refetch just the live tail [closedBefore, toMs] rather than the whole window — so a window whose
      // bounded post-trade context reaches the last couple of days (near-now) doesn't re-pull a year of
      // immutable history on every view. The cached prefix is served and stitched with the fresh tail.
      const closedEnd = Math.min(toMs, closedBefore);
      const prefixCached = closedEnd <= fromMs || isCovered(ivs, fromMs, closedEnd);
      const fetchFrom = nearNow && prefixCached ? Math.max(fromMs, closedBefore) : fromMs;

      let fresh: Candle[] = [];
      try {
        fresh = await source.getCandles(symbol, fetchFrom, toMs, resMs);
      } catch {
        // Source down: serve only if a single stored interval FULLY covers the request — never a partial
        // window, so a wrong excursion range can't reach MAE/MFE; otherwise degrade to [].
        return covered ? readBars(db, symbol, resMs, fromMs, toMs) : [];
      }
      if (fresh.length) {
        writeBars(db, symbol, resMs, fresh);
        // Record coverage only up to the CLOSED boundary, and only for the range we actually fetched. A
        // near-now fetch may include a partial current bar; marking [from,to] fully covered would later
        // (once now advances past the tail) serve that stale partial bar without refetching. Capping at
        // the closed boundary (now − TAIL − one bar-width) forces the tail to refetch until it closes;
        // a tail-only fetch adds no new coverage (the prefix's coverage already stands). The just-fetched
        // bars are still returned to this caller.
        const coverEnd = Math.min(toMs, closedBefore);
        if (coverEnd > fetchFrom) addCoverage(db, symbol, resMs, fetchFrom, coverEnd, now);
        return readBars(db, symbol, resMs, fromMs, toMs);
      }
      // Empty fresh response — the live source degrades fetch/parse failures to [] (it doesn't throw),
      // so treat it like the catch path: serve cache only if fully covered, else no bars.
      return covered ? readBars(db, symbol, resMs, fromMs, toMs) : [];
    },
  };
}
