import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../src/store/migrations";
import {
  getJournal,
  upsertJournal,
  getWeeklyEntry,
  upsertWeeklyEntry,
  tradesInRange,
  manualStops,
} from "../../src/store/journal";

function db() {
  const d = new Database(":memory:");
  runMigrations(d);
  return d;
}

test("upsertJournal round-trips fields + tags; getJournal returns null when absent", () => {
  const d = db();
  expect(getJournal(d, "t1")).toBeNull();
  upsertJournal(d, {
    tradeId: "t1", thesis: "breakout", emotion: "calm", conviction: 4, rating: 3,
    notes: "took it", manualStop: 12.5, setup: "breakout", tags: ["a", "b"], updatedAt: 100,
  });
  const j = getJournal(d, "t1")!;
  expect(j.manualStop).toBe(12.5);
  expect(j.setup).toBe("breakout");
  expect(j.tags.sort()).toEqual(["a", "b"]);
  expect(manualStops(d).get("t1")).toBe(12.5);
});

test("upsertJournal replaces tags (not append) and is idempotent", () => {
  const d = db();
  upsertJournal(d, {
    tradeId: "t1", thesis: null, emotion: null, conviction: null, rating: null,
    notes: null, manualStop: null, setup: null, tags: ["x", "y"], updatedAt: 1,
  });
  upsertJournal(d, {
    tradeId: "t1", thesis: null, emotion: null, conviction: null, rating: null,
    notes: null, manualStop: null, setup: null, tags: ["y", "z"], updatedAt: 2,
  });
  expect(getJournal(d, "t1")!.tags.sort()).toEqual(["y", "z"]);
});

test("JOURNAL SURVIVES A FULL DERIVED REBUILD (load-bearing invariant)", () => {
  const d = db();
  d.run(
    `INSERT INTO trades (id, account, symbol, currency, direction, status, open_time, avg_entry, max_qty, fees, coverage_ok)
     VALUES ('t1','a','US.AAPL','USD','LONG','closed', 100, 10, 1, 0, 1)`,
  );
  upsertJournal(d, {
    tradeId: "t1", thesis: "keep me", emotion: null, conviction: null, rating: null,
    notes: null, manualStop: 9, setup: "breakout", tags: ["keep"], updatedAt: 1,
  });
  // Simulate replaceDerived's wipe:
  d.run(`DELETE FROM flags`);
  d.run(`DELETE FROM trade_fills`);
  d.run(`DELETE FROM trades`);
  const j = getJournal(d, "t1");
  expect(j).not.toBeNull();
  expect(j!.thesis).toBe("keep me");
  expect(j!.tags).toEqual(["keep"]);
});

test("weekly entry round-trips with watchlist; tradesInRange filters by open OR close time", () => {
  const d = db();
  upsertWeeklyEntry(d, {
    id: "2026-W28", periodStart: 0, periodEnd: 1000, marketRead: "risk-on",
    tradedVsPlan: "ok", watchlist: [{ symbol: "US.NVDA", note: "watch", keyLevel: 120 }], updatedAt: 5,
  });
  const w = getWeeklyEntry(d, "2026-W28")!;
  expect(w.marketRead).toBe("risk-on");
  expect(w.watchlist[0]!.symbol).toBe("US.NVDA");
  d.run(
    `INSERT INTO trades (id, account, symbol, currency, direction, status, open_time, close_time, avg_entry, max_qty, fees, coverage_ok)
     VALUES ('t1','a','US.AAPL','USD','LONG','closed', 500, 900, 10, 1, 0, 1)`,
  );
  expect(tradesInRange(d, 0, 1000).map((t) => t.id)).toEqual(["t1"]);
  expect(tradesInRange(d, 2000, 3000)).toHaveLength(0);
});
