import type { Database } from "bun:sqlite";
import type { CandleSource } from "../domain/ports";
import type { Candle } from "../domain/types";

const TAIL_MS = 2 * 86_400_000; // last ~2 days may be partial/backfilled → refetch

export interface CacheOpts {
  now: number;
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
      const covered = isCovered(intervals(db, symbol, resMs), fromMs, toMs);
      const nearNow = toMs >= opts.now - TAIL_MS;
      if (covered && !nearNow) return readBars(db, symbol, resMs, fromMs, toMs);

      let fresh: Candle[] = [];
      try {
        fresh = await source.getCandles(symbol, fromMs, toMs, resMs);
      } catch {
        return covered ? readBars(db, symbol, resMs, fromMs, toMs) : [];
      }
      if (fresh.length) {
        writeBars(db, symbol, resMs, fresh);
        // Record coverage only up to the CLOSED boundary. A near-now fetch may include a partial
        // current bar; marking [from,to] fully covered would later (once now advances past the tail)
        // serve that stale partial bar without refetching. Capping coverage at now−TAIL forces the
        // tail to refetch until its bars close. The just-fetched bars are still returned to this caller.
        const coverEnd = Math.min(toMs, opts.now - TAIL_MS);
        if (coverEnd > fromMs) addCoverage(db, symbol, resMs, fromMs, coverEnd, opts.now);
        return readBars(db, symbol, resMs, fromMs, toMs);
      }
      // Empty fresh response — the live source degrades fetch/parse failures to [] (it doesn't throw),
      // so treat it like the catch path: serve cache only if fully covered, else no bars.
      return covered ? readBars(db, symbol, resMs, fromMs, toMs) : [];
    },
  };
}
