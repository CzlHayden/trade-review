import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../src/store/migrations";
import { cachedCandles } from "../../src/store/candles-cache";
import type { Candle } from "../../src/domain/types";

function db() {
  const d = new Database(":memory:");
  runMigrations(d);
  return d;
}
const DAY = 86_400_000;
const bars = (times: number[]): Candle[] =>
  times.map((t) => ({ time: t, open: 1, high: 2, low: 1, close: 1.5, volume: 10 }));

test("first call hits the source and caches; second identical call serves from cache (no source hit)", async () => {
  const d = db();
  let hits = 0;
  const src = {
    getCandles: async (_s: string, from: number) => {
      hits++;
      return bars([from, from + DAY]);
    },
  };
  const c = cachedCandles(d, src, { now: 100 * DAY }); // old range → fully cacheable, no tail refetch
  const from = 1 * DAY,
    to = 3 * DAY,
    res = DAY;
  const a = await c.getCandles("US.AAPL", from, to, res);
  const b = await c.getCandles("US.AAPL", from, to, res);
  expect(a.length).toBeGreaterThan(0);
  expect(b).toEqual(a);
  expect(hits).toBe(1); // second call served from cache
});

test("a range ending near now refetches the tail (partial last bar)", async () => {
  const d = db();
  let hits = 0;
  const now = 100 * DAY;
  const src = {
    getCandles: async (_s: string, from: number) => {
      hits++;
      return bars([from]);
    },
  };
  const c = cachedCandles(d, src, { now });
  await c.getCandles("US.AAPL", now - 3 * DAY, now, DAY);
  await c.getCandles("US.AAPL", now - 3 * DAY, now, DAY); // still near now → refetch tail
  expect(hits).toBe(2);
});

test("two DISJOINT ranges do not mark the gap between them as covered", async () => {
  const d = db();
  let hits = 0;
  const now = 100 * DAY;
  const src = {
    getCandles: async (_s: string, from: number, to: number) => {
      hits++;
      return bars([from, to]);
    },
  };
  const c = cachedCandles(d, src, { now });
  await c.getCandles("US.AAPL", 1 * DAY, 3 * DAY, DAY); // range A (Jan-ish)
  await c.getCandles("US.AAPL", 40 * DAY, 42 * DAY, DAY); // range B, disjoint from A
  expect(hits).toBe(2);
  // A request spanning the GAP between A and B must refetch (not be served as falsely covered).
  await c.getCandles("US.AAPL", 10 * DAY, 12 * DAY, DAY);
  expect(hits).toBe(3);
});

test("source failure with a warm cache still returns cached bars", async () => {
  const d = db();
  const now = 100 * DAY;
  const good = { getCandles: async (_s: string, from: number) => bars([from, from + DAY]) };
  const c1 = cachedCandles(d, good, { now });
  await c1.getCandles("US.AAPL", 1 * DAY, 3 * DAY, DAY);
  const bad = {
    getCandles: async () => {
      throw new Error("network down");
    },
  };
  const c2 = cachedCandles(d, bad, { now });
  const out = await c2.getCandles("US.AAPL", 1 * DAY, 3 * DAY, DAY);
  expect(out.length).toBeGreaterThan(0); // served from cache despite source throwing (fully covered)
});

test("source failure on a NOT-fully-covered range degrades to [] (no partial-window bars)", async () => {
  const d = db();
  const now = 100 * DAY;
  const good = { getCandles: async (_s: string, from: number) => bars([from, from + DAY]) };
  await cachedCandles(d, good, { now }).getCandles("US.AAPL", 1 * DAY, 3 * DAY, DAY); // covers [1,3]d only
  const bad = {
    getCandles: async () => {
      throw new Error("network down");
    },
  };
  // Request a wider range the cache only partially covers; on failure it must NOT return the [1,3]d
  // overlap (which would be a wrong excursion window), but degrade to no bars.
  const out = await cachedCandles(d, bad, { now }).getCandles("US.AAPL", 1 * DAY, 50 * DAY, DAY);
  expect(out).toEqual([]);
});
