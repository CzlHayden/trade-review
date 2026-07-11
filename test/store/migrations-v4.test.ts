import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations, MIGRATIONS } from "../../src/store/migrations";

function cols(db: Database, table: string): string[] {
  return (db.query(`PRAGMA table_info(${table})`).all() as any[]).map((r) => r.name);
}

test("migration v4 adds journal + candle-cache tables with NO FK to trades", () => {
  const db = new Database(":memory:");
  runMigrations(db);
  expect(MIGRATIONS.length).toBeGreaterThanOrEqual(4);
  for (const t of [
    "journal",
    "journal_tags",
    "journal_entries",
    "watchlist_items",
    "candles_cache",
    "candle_coverage",
  ]) {
    expect(cols(db, t).length).toBeGreaterThan(0);
  }
  // Orphan-tolerance: journal must NOT declare a foreign key to trades.
  expect((db.query(`PRAGMA foreign_key_list(journal)`).all() as any[]).length).toBe(0);
  expect(cols(db, "journal")).toContain("manual_stop");
  expect(cols(db, "journal")).toContain("setup");
});

test("a journal row survives DELETE FROM trades (rebuild-safety at the schema level)", () => {
  const db = new Database(":memory:");
  runMigrations(db);
  db.run(`INSERT INTO journal (trade_id, updated_at) VALUES ('t1', 1)`);
  db.run(`DELETE FROM trades`); // what replaceDerived does every sync
  expect(db.query(`SELECT trade_id FROM journal`).all() as any[]).toHaveLength(1);
});
