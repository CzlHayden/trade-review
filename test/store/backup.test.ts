import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../../src/store/db";
import { backupDb } from "../../src/store/backup";

const SUFFIXES = ["", "-wal", "-shm"];

test("backup captures committed WAL data, not just the main file", () => {
  const path = join(tmpdir(), `tr-backup-${process.pid}.sqlite`);
  for (const s of SUFFIXES) rmSync(path + s, { force: true });

  const db = openDb(path); // WAL mode enabled
  db.run("CREATE TABLE t (x INTEGER);");
  db.run("INSERT INTO t (x) VALUES (42);");
  // Deliberately NOT checkpointing: 42 lives in the -wal file, not the main db file.

  const dest = backupDb(path, "test");
  expect(dest).not.toBeNull();

  const bdb = new Database(dest!, { readonly: true });
  const row = bdb.query("SELECT x FROM t;").get() as { x: number } | null;
  expect(row?.x).toBe(42); // a plain file-copy backup would miss this
  bdb.close();
  db.close();

  for (const s of SUFFIXES) rmSync(path + s, { force: true });
  rmSync(dest!, { force: true });
});

test("backup returns null when the db file does not exist", () => {
  const path = join(tmpdir(), `tr-backup-missing-${process.pid}.sqlite`);
  rmSync(path, { force: true });
  expect(backupDb(path, "test")).toBeNull();
});
