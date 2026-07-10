import type { Database } from "bun:sqlite";

/** Ordered list of migrations. Append new ones; never edit or reorder shipped entries. */
export const MIGRATIONS: ReadonlyArray<(db: Database) => void> = [
  // v1 — initial schema
  (db) => {
    db.run(`
      CREATE TABLE raw_fills (
        id TEXT PRIMARY KEY, order_id TEXT, symbol TEXT NOT NULL, side TEXT NOT NULL,
        qty REAL NOT NULL, price REAL NOT NULL, fee REAL NOT NULL DEFAULT 0,
        currency TEXT NOT NULL, time INTEGER NOT NULL, account TEXT NOT NULL
      );
    `);
    db.run(`
      CREATE TABLE trades (
        id TEXT PRIMARY KEY, account TEXT NOT NULL, symbol TEXT NOT NULL, currency TEXT NOT NULL,
        direction TEXT NOT NULL, status TEXT NOT NULL,
        open_time INTEGER NOT NULL, close_time INTEGER,
        avg_entry REAL NOT NULL, avg_exit REAL, max_qty REAL NOT NULL,
        realized_pnl REAL, fees REAL NOT NULL DEFAULT 0, hold_seconds INTEGER,
        coverage_ok INTEGER NOT NULL DEFAULT 1
      );
    `);
    db.run(`
      CREATE TABLE trade_fills (
        trade_id TEXT NOT NULL, fill_id TEXT NOT NULL,
        PRIMARY KEY (trade_id, fill_id)
      );
    `);
  },
];

export function currentVersion(db: Database): number {
  db.run("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);");
  const row = db.query("SELECT version FROM schema_version LIMIT 1;").get() as
    | { version: number }
    | null;
  return row?.version ?? 0;
}

function setVersion(db: Database, version: number): void {
  db.run("DELETE FROM schema_version;");
  db.run("INSERT INTO schema_version (version) VALUES (?);", [version]);
}

/** Apply every migration whose 1-based index exceeds the current version. */
export function runMigrations(db: Database): void {
  const from = currentVersion(db);
  if (from > MIGRATIONS.length) {
    // An older binary opened a DB written by a newer one (possible with self-update).
    // Refuse rather than run against an unknown schema.
    throw new Error(
      `Database schema version ${from} is newer than this app supports (${MIGRATIONS.length}). Please update the app.`,
    );
  }
  for (let i = from; i < MIGRATIONS.length; i++) {
    const migrate = MIGRATIONS[i]!;
    db.transaction(() => {
      migrate(db);
      setVersion(db, i + 1);
    })();
  }
}
