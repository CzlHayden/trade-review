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
