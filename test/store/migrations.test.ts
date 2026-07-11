import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations, MIGRATIONS, currentVersion } from "../../src/store/migrations";

function memDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON;");
  return db;
}

test("fresh db migrates to latest version", () => {
  const db = memDb();
  runMigrations(db);
  expect(currentVersion(db)).toBe(MIGRATIONS.length);
});

test("creates the raw_fills and trades tables", () => {
  const db = memDb();
  runMigrations(db);
  const names = db
    .query("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((r: any) => r.name);
  expect(names).toContain("raw_fills");
  expect(names).toContain("trades");
});

test("running migrations twice is idempotent", () => {
  const db = memDb();
  runMigrations(db);
  const v1 = currentVersion(db);
  runMigrations(db); // second run applies nothing
  expect(currentVersion(db)).toBe(v1);
});

test("refuses to run against a db newer than the app supports", () => {
  const db = memDb();
  runMigrations(db);
  db.run("DELETE FROM schema_version;");
  db.run("INSERT INTO schema_version (version) VALUES (?);", [MIGRATIONS.length + 5]);
  expect(() => runMigrations(db)).toThrow(/newer than this app supports/);
});

test("v2 adds raw_orders, raw_positions, and sync_state tables", () => {
  const db = memDb();
  runMigrations(db);
  const names = db
    .query("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((r: any) => r.name);
  expect(names).toContain("raw_orders");
  expect(names).toContain("raw_positions");
  expect(names).toContain("sync_state");
});

test("v2 adds enrichment columns to trades", () => {
  const db = memDb();
  runMigrations(db);
  const cols = db
    .query("PRAGMA table_info(trades)")
    .all()
    .map((r: any) => r.name);
  for (const c of ["effective_stop", "effective_tp", "risk", "r_multiple", "mae", "mfe"]) {
    expect(cols).toContain(c);
  }
});

test("v3 adds flags and config tables", () => {
  const db = memDb();
  runMigrations(db);
  const names = db
    .query("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((r: any) => r.name);
  expect(names).toContain("flags");
  expect(names).toContain("config");
});

test("v6 adds account_funds keyed on (account, time, currency)", () => {
  const db = memDb();
  runMigrations(db);
  const names = db
    .query("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((r: any) => r.name);
  expect(names).toContain("account_funds");
  const cols = db
    .query("PRAGMA table_info(account_funds)")
    .all()
    .map((r: any) => r.name);
  for (const c of ["account", "time", "currency", "total_assets", "cash", "market_val"]) {
    expect(cols).toContain(c);
  }
});
