import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../src/store/migrations";
import { rebuildDerived } from "../../src/sync/sync";
import { allTrades, insertPositionSnapshot, upsertRawFills } from "../../src/store/repos";
import { upsertJournal } from "../../src/store/journal";
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
