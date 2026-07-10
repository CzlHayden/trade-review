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

/**
 * Wrap a CandleSource so bars fetched once are cached. Closed bars are immutable; only a range whose
 * end is within TAIL_MS of `now` refetches (the last bar is partial and the source backfills). A
 * source failure with a warm cache degrades to the cached bars rather than throwing.
 */
export function cachedCandles(db: Database, source: CandleSource, opts: CacheOpts): CandleSource {
  return {
    async getCandles(symbol, fromMs, toMs, resMs) {
      const coverage = db
        .query(`SELECT from_ms, to_ms FROM candle_coverage WHERE symbol=? AND res_ms=?`)
        .get(symbol, resMs) as { from_ms: number; to_ms: number } | null;
      const covered = coverage !== null && coverage.from_ms <= fromMs && coverage.to_ms >= toMs;
      const nearNow = toMs >= opts.now - TAIL_MS;
      if (covered && !nearNow) return readBars(db, symbol, resMs, fromMs, toMs);

      let fresh: Candle[] = [];
      try {
        fresh = await source.getCandles(symbol, fromMs, toMs, resMs);
      } catch {
        return readBars(db, symbol, resMs, fromMs, toMs); // degrade to cache on source failure
      }
      if (fresh.length) {
        writeBars(db, symbol, resMs, fresh);
        const newFrom = coverage ? Math.min(coverage.from_ms, fromMs) : fromMs;
        const newTo = coverage ? Math.max(coverage.to_ms, toMs) : toMs;
        db.run(
          `INSERT INTO candle_coverage (symbol,res_ms,from_ms,to_ms,fetched_at) VALUES (?,?,?,?,?)
           ON CONFLICT(symbol,res_ms) DO UPDATE SET from_ms=excluded.from_ms, to_ms=excluded.to_ms, fetched_at=excluded.fetched_at`,
          [symbol, resMs, newFrom, newTo, opts.now],
        );
      }
      return readBars(db, symbol, resMs, fromMs, toMs);
    },
  };
}
