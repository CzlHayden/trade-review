import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../src/store/migrations";
import { openPositions, metaView, latestSnapshotTime } from "../../src/api/views";
import { insertPositionSnapshot } from "../../src/store/repos";
import { setConfigValue, LAST_SNAPSHOT_TIME } from "../../src/store/config";

function db() {
  const d = new Database(":memory:");
  runMigrations(d);
  return d;
}

test("openPositions joins snapshot + open trade and computes open risk per currency", () => {
  const d = db();
  d.run(
    `INSERT INTO trades (id, account, symbol, currency, direction, status, open_time, avg_entry, max_qty, fees, coverage_ok, effective_stop)
     VALUES ('t1','a','US.AAPL','USD','LONG','open', 1000, 100, 10, 0, 1, 95)`,
  );
  insertPositionSnapshot(d, [
    { account: "a", symbol: "US.AAPL", qty: 10, avgCost: 100, currency: "USD", time: 5000 },
  ]);
  const pos = openPositions(d, 5000);
  expect(pos).toHaveLength(1);
  expect(pos[0]!.currency).toBe("USD");
  expect(pos[0]!.openRisk).toBeCloseTo(50); // (100-95)*10
});

test("openPositions leaves open risk null when the open trade has no effective stop", () => {
  const d = db();
  d.run(
    `INSERT INTO trades (id, account, symbol, currency, direction, status, open_time, avg_entry, max_qty, fees, coverage_ok)
     VALUES ('t1','a','US.AAPL','USD','LONG','open', 1000, 100, 10, 0, 1)`,
  );
  insertPositionSnapshot(d, [
    { account: "a", symbol: "US.AAPL", qty: 10, avgCost: 100, currency: "USD", time: 5000 },
  ]);
  expect(openPositions(d, 5000)[0]!.openRisk).toBeNull();
});

test("latestSnapshotTime prefers the marker, backfilling from stored snapshots when it's absent", () => {
  const d = db();
  // Migrated (pre-marker) DB: no marker, but raw_positions has the last sync batch → use MAX(time).
  insertPositionSnapshot(d, [
    { account: "a", symbol: "US.AAPL", qty: 1, avgCost: 1, currency: "USD", time: 4000 },
  ]);
  expect(latestSnapshotTime(d)).toBe(4000);
  // Once a sync writes the marker, it wins (so an all-flat sync can report zero holdings).
  setConfigValue(d, LAST_SNAPSHOT_TIME, "9000");
  expect(latestSnapshotTime(d)).toBe(9000);
});

test("metaView surfaces currencies, setups, tags, accounts, coverage window", () => {
  const d = db();
  d.run(
    `INSERT INTO trades (id, account, symbol, currency, direction, status, open_time, avg_entry, max_qty, fees, coverage_ok)
     VALUES ('t1','a','US.AAPL','USD','LONG','closed', 1000, 100, 10, 0, 1)`,
  );
  d.run(`INSERT INTO journal (trade_id, setup, updated_at) VALUES ('t1','breakout',1)`);
  d.run(`INSERT INTO journal_tags (trade_id, tag) VALUES ('t1','earnings')`);
  const m = metaView(d);
  expect(m.currencies).toContain("USD");
  expect(m.setups).toContain("breakout");
  expect(m.tags).toContain("earnings");
  expect(m.accounts).toContain("a");
  expect(typeof m.appVersion).toBe("string");
});
