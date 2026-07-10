import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../src/store/migrations";
import { rebuildDerived } from "../../src/sync/sync";
import { allTrades, upsertRawFills } from "../../src/store/repos";
import { upsertJournal } from "../../src/store/journal";
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
