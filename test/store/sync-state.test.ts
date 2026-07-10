import { test, expect } from "bun:test";
import { openTestDb } from "../helpers";
import { getSyncState, upsertSyncState } from "../../src/store/sync-state";

test("getSyncState returns null before any sync", () => {
  const db = openTestDb();
  expect(getSyncState(db, "acc1", "US")).toBeNull();
});

test("upsertSyncState persists and getSyncState reads it back", () => {
  const db = openTestDb();
  upsertSyncState(db, { account: "acc1", market: "US", lastSyncedTime: 5000, coverageStart: 1000 });
  expect(getSyncState(db, "acc1", "US")).toEqual({
    account: "acc1", market: "US", lastSyncedTime: 5000, coverageStart: 1000,
  });
});

test("upsertSyncState updates in place (PK is account+market)", () => {
  const db = openTestDb();
  upsertSyncState(db, { account: "acc1", market: "US", lastSyncedTime: 5000, coverageStart: 1000 });
  upsertSyncState(db, { account: "acc1", market: "US", lastSyncedTime: 9000, coverageStart: 1000 });
  expect(getSyncState(db, "acc1", "US")!.lastSyncedTime).toBe(9000);
  const n = db.query("SELECT COUNT(*) AS n FROM sync_state").get() as { n: number };
  expect(n.n).toBe(1);
});

test("different markets on the same account are separate rows", () => {
  const db = openTestDb();
  upsertSyncState(db, { account: "acc1", market: "US", lastSyncedTime: 5000, coverageStart: 1000 });
  upsertSyncState(db, { account: "acc1", market: "HK", lastSyncedTime: 6000, coverageStart: 2000 });
  expect(getSyncState(db, "acc1", "US")!.lastSyncedTime).toBe(5000);
  expect(getSyncState(db, "acc1", "HK")!.lastSyncedTime).toBe(6000);
});

test("null cursor fields round-trip as null", () => {
  const db = openTestDb();
  upsertSyncState(db, { account: "acc1", market: "US", lastSyncedTime: null, coverageStart: null });
  const s = getSyncState(db, "acc1", "US")!;
  expect(s.lastSyncedTime).toBeNull();
  expect(s.coverageStart).toBeNull();
});
