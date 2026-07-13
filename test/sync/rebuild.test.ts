import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../src/store/migrations";
import { rebuildDerived, backfillLiveStops } from "../../src/sync/sync";
import { allTrades, insertPositionSnapshot, upsertRawFills, upsertRawOrders } from "../../src/store/repos";
import { upsertJournal } from "../../src/store/journal";
import { order } from "../helpers";
import { setConfigValue, LAST_SNAPSHOT_TIME } from "../../src/store/config";
import { upsertSyncState } from "../../src/store/sync-state";
import { DEFAULT_RULE_CONFIG } from "../../src/domain/types";

const noCandles = { getCandles: async () => [] };

function seedRoundTrip(db: Database) {
  upsertRawFills(db, [
    { id: "f1", orderId: "o1", symbol: "US.AAPL", side: "BUY", qty: 10, price: 100, fee: 0, currency: "USD", time: 1000, account: "a" },
    { id: "f2", orderId: "o2", symbol: "US.AAPL", side: "SELL", qty: 10, price: 110, fee: 0, currency: "USD", time: 2000, account: "a" },
  ]);
}

test("backfillLiveStops fills live_stop for open trades from stored orders (upgraded DB, pre first sync)", () => {
  const db = new Database(":memory:");
  runMigrations(db);
  // Simulate a v9-migrated DB whose trades predate the live_stop column: an OPEN trade with a working
  // protective stop order, but live_stop still NULL (never re-derived). No OpenD / candles involved.
  db.run(
    `INSERT INTO trades (id, account, symbol, currency, direction, status, open_time, avg_entry, max_qty, fees, coverage_ok, effective_stop)
     VALUES ('t1','acc1','AAPL','USD','LONG','open', 60000, 10, 100, 0, 1, 9)`,
  );
  upsertRawOrders(db, [order("SELL", "STOP", 100, { triggerPrice: 9, createTime: 120000, status: "SUBMITTED" })]);
  expect(allTrades(db)[0]!.liveStop).toBeNull(); // column exists but is empty until backfill/sync

  backfillLiveStops(db);
  expect(allTrades(db)[0]!.liveStop).toBe(9); // inferred from the working stop order, no sync needed
});

test("backfillLiveStops leaves live_stop NULL when the only stop was cancelled (genuinely unprotected)", () => {
  const db = new Database(":memory:");
  runMigrations(db);
  db.run(
    `INSERT INTO trades (id, account, symbol, currency, direction, status, open_time, avg_entry, max_qty, fees, coverage_ok, effective_stop)
     VALUES ('t1','acc1','AAPL','USD','LONG','open', 60000, 10, 100, 0, 1, 9)`,
  );
  upsertRawOrders(db, [order("SELL", "STOP", 100, { triggerPrice: 9, createTime: 120000, status: "CANCELLED_ALL" })]);
  backfillLiveStops(db);
  expect(allTrades(db)[0]!.liveStop).toBeNull(); // a cancelled stop is not live → still unprotected
});

test("rebuildDerived rebuilds trades from raw with no OpenD involved", async () => {
  const db = new Database(":memory:");
  runMigrations(db);
  seedRoundTrip(db);
  await rebuildDerived(db, { candles: noCandles, config: DEFAULT_RULE_CONFIG, now: 3000 });
  const trades = allTrades(db);
  expect(trades).toHaveLength(1);
  expect(trades[0]!.realizedPnl).toBe(100);
});

test("a manual stop overrides inference → risk/rMultiple recompute via rebuildDerived", async () => {
  const db = new Database(":memory:");
  runMigrations(db);
  seedRoundTrip(db);
  await rebuildDerived(db, { candles: noCandles, config: DEFAULT_RULE_CONFIG, now: 3000 });
  const before = allTrades(db)[0]!;
  expect(before.risk).toBeNull(); // no protective order, no manual stop → no risk

  upsertJournal(db, {
    tradeId: before.id, thesis: null, emotion: null, conviction: null, rating: null,
    notes: null, manualStop: 95, setup: null, tags: [], updatedAt: 1,
  });
  await rebuildDerived(db, { candles: noCandles, config: DEFAULT_RULE_CONFIG, now: 3000 });
  const after = allTrades(db)[0]!;
  expect(after.risk).toBeCloseTo(50); // |100 - 95| * 10
  expect(after.rMultiple).toBeCloseTo(2); // realized 100 / risk 50
  expect(after.effectiveStop).toBe(95);
  expect(after.liveStop).toBe(95); // a manual stop is authoritative for the live readout too
});

test("a standalone rebuild reconciles seeds against the snapshot MARKER, not wall-clock now", async () => {
  // Pre-existing 10-long AAPL (snapshot at t=1000 shows the CURRENT 5 that remain after an in-window
  // sell of 5). A journal-triggered rebuild passes a later wall-clock `now` that matches no snapshot.
  const db = new Database(":memory:");
  runMigrations(db);
  insertPositionSnapshot(db, [
    { account: "a", symbol: "US.AAPL", qty: 5, avgCost: 100, price: null, currency: "USD", time: 1000 },
  ]);
  setConfigValue(db, LAST_SNAPSHOT_TIME, "1000"); // pullRaw would have written this
  upsertRawFills(db, [
    { id: "s1", orderId: "o1", symbol: "US.AAPL", side: "SELL", qty: 5, price: 110, fee: 0, currency: "USD", time: 1500, account: "a" },
  ]);

  await rebuildDerived(db, { candles: noCandles, config: DEFAULT_RULE_CONFIG, now: 9_999_999 });
  const trades = allTrades(db);
  expect(trades).toHaveLength(1);
  // Seed = snapshot(5) − netFills(−5) = 10 long. Selling 5 leaves 5 → the trade stays OPEN and
  // coverage-incomplete. If seeds had been reconciled against `now` (empty snapshot), the seed would
  // be only 5 and the trade would wrongly CLOSE. This asserts the marker path.
  expect(trades[0]!.status).toBe("open");
  expect(trades[0]!.coverageOk).toBe(false);
  expect(trades[0]!.maxQty).toBe(10);
});

test("a seed-only holding keeps a STABLE trade id across syncs (journal never orphans)", async () => {
  // A pre-window position never traded in-window (no fills). Its seed time must be the stable
  // coverage floor, not the advancing snapshot clock — otherwise its id changes each sync.
  const db = new Database(":memory:");
  runMigrations(db);
  upsertSyncState(db, { account: "a", market: "US", lastSyncedTime: 1000, coverageStart: 500 });
  insertPositionSnapshot(db, [
    { account: "a", symbol: "US.AAPL", qty: 10, avgCost: 100, price: null, currency: "USD", time: 1000 },
  ]);
  setConfigValue(db, LAST_SNAPSHOT_TIME, "1000");
  await rebuildDerived(db, { candles: noCandles, config: DEFAULT_RULE_CONFIG, now: 1000 });
  const idA = allTrades(db)[0]!.id;

  // Next sync advances the snapshot clock; the seed-only holding is unchanged.
  setConfigValue(db, LAST_SNAPSHOT_TIME, "9999999");
  insertPositionSnapshot(db, [
    { account: "a", symbol: "US.AAPL", qty: 10, avgCost: 100, price: null, currency: "USD", time: 9999999 },
  ]);
  await rebuildDerived(db, { candles: noCandles, config: DEFAULT_RULE_CONFIG, now: 9999999 });
  const idB = allTrades(db)[0]!.id;

  expect(idB).toBe(idA); // stable id ⇒ a journal keyed to idA stays attached
});
