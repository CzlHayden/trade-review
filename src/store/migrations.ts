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
  // v2 — enrichment columns on trades + raw orders/positions + sync state
  (db) => {
    for (const col of [
      "effective_stop REAL",
      "effective_tp REAL",
      "risk REAL",
      "r_multiple REAL",
      "mae REAL",
      "mfe REAL",
    ]) {
      db.run(`ALTER TABLE trades ADD COLUMN ${col};`);
    }
    db.run(`
      CREATE TABLE raw_orders (
        id TEXT PRIMARY KEY, symbol TEXT NOT NULL, side TEXT NOT NULL, type TEXT NOT NULL,
        qty REAL NOT NULL, price REAL, trigger_price REAL,
        status TEXT NOT NULL, create_time INTEGER NOT NULL, update_time INTEGER, account TEXT NOT NULL
      );
    `);
    db.run(`
      CREATE TABLE raw_positions (
        account TEXT NOT NULL, symbol TEXT NOT NULL, qty REAL NOT NULL,
        avg_cost REAL NOT NULL, currency TEXT NOT NULL, time INTEGER NOT NULL,
        PRIMARY KEY (account, symbol, time)
      );
    `);
    db.run(`
      CREATE TABLE sync_state (
        account TEXT NOT NULL, market TEXT NOT NULL,
        last_synced_time INTEGER, coverage_start INTEGER,
        PRIMARY KEY (account, market)
      );
    `);
  },
  // v3 — computed flags + config key/value store
  (db) => {
    db.run(`
      CREATE TABLE flags (
        trade_id TEXT NOT NULL, rule_id TEXT NOT NULL,
        severity TEXT NOT NULL, reason TEXT NOT NULL,
        PRIMARY KEY (trade_id, rule_id)
      );
    `);
    db.run(`
      CREATE TABLE config (
        key TEXT PRIMARY KEY, value TEXT NOT NULL
      );
    `);
  },
  // v4 — user-written journaling (orphan-tolerant: NO FK to trades, which is rebuilt every sync)
  //      + candle cache (immutable closed bars) with range-coverage bookkeeping.
  (db) => {
    db.run(`
      CREATE TABLE journal (
        trade_id TEXT PRIMARY KEY,
        thesis TEXT, emotion TEXT,
        conviction INTEGER, rating INTEGER,
        notes TEXT, manual_stop REAL, setup TEXT,
        updated_at INTEGER NOT NULL
      );
    `);
    db.run(`
      CREATE TABLE journal_tags (
        trade_id TEXT NOT NULL, tag TEXT NOT NULL,
        PRIMARY KEY (trade_id, tag)
      );
    `);
    db.run(`
      CREATE TABLE journal_entries (
        id TEXT PRIMARY KEY,            -- ISO week key, e.g. "2026-W28"
        period_start INTEGER NOT NULL,  -- epoch ms, inclusive
        period_end INTEGER NOT NULL,    -- epoch ms, exclusive
        market_read TEXT, traded_vs_plan TEXT,
        updated_at INTEGER NOT NULL
      );
    `);
    db.run(`
      CREATE TABLE watchlist_items (
        entry_id TEXT NOT NULL, symbol TEXT NOT NULL,
        note TEXT, key_level REAL,
        PRIMARY KEY (entry_id, symbol)
      );
    `);
    db.run(`
      CREATE TABLE candles_cache (
        symbol TEXT NOT NULL, res_ms INTEGER NOT NULL, time INTEGER NOT NULL,
        open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL,
        volume REAL NOT NULL DEFAULT 0,
        PRIMARY KEY (symbol, res_ms, time)
      );
    `);
    db.run(`
      CREATE TABLE candle_coverage (
        symbol TEXT NOT NULL, res_ms INTEGER NOT NULL,
        from_ms INTEGER NOT NULL, to_ms INTEGER NOT NULL, fetched_at INTEGER NOT NULL,
        PRIMARY KEY (symbol, res_ms)
      );
    `);
  },
  // v5 — candle_coverage becomes MULTI-INTERVAL: PK (symbol,res_ms,from_ms) so two disjoint fetched
  // windows for the same symbol coexist instead of one overwriting the other. Coverage is a pure
  // cache index (bars live in candles_cache), so dropping/recreating it only re-accumulates on the
  // next fetch — never loses candles.
  (db) => {
    db.run(`DROP TABLE IF EXISTS candle_coverage;`);
    db.run(`
      CREATE TABLE candle_coverage (
        symbol TEXT NOT NULL, res_ms INTEGER NOT NULL,
        from_ms INTEGER NOT NULL, to_ms INTEGER NOT NULL, fetched_at INTEGER NOT NULL,
        PRIMARY KEY (symbol, res_ms, from_ms)
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
