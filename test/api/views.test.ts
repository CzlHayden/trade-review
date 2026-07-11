import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../src/store/migrations";
import { openPositions, openPositionsByCurrency, metaView, latestSnapshotTime, tradeDetail } from "../../src/api/views";
import { insertPositionSnapshot } from "../../src/store/repos";
import { insertFunds } from "../../src/store/funds";
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

test("openPositionsByCurrency totals open risk and computes risk % of latest equity, per currency", () => {
  const d = db();
  d.run(
    `INSERT INTO trades (id, account, symbol, currency, direction, status, open_time, avg_entry, max_qty, fees, coverage_ok, effective_stop)
     VALUES ('t1','a','US.AAPL','USD','LONG','open', 1000, 100, 10, 0, 1, 95)`,
  );
  insertPositionSnapshot(d, [
    { account: "a", symbol: "US.AAPL", qty: 10, avgCost: 100, currency: "USD", time: 5000 },
  ]);
  insertFunds(d, { account: "a", currency: "USD", totalAssets: 10_000, cash: 0, marketVal: 0, time: 5000 });
  const { byCurrency } = openPositionsByCurrency(d, 5000);
  expect(byCurrency).toHaveLength(1);
  expect(byCurrency[0]!.totalOpenRisk).toBeCloseTo(50); // (100-95)*10
  expect(byCurrency[0]!.equity).toBe(10_000);
  expect(byCurrency[0]!.riskPct).toBeCloseTo(0.005); // 50 / 10000
});

test("openPositionsByCurrency leaves risk % null when no equity snapshot exists", () => {
  const d = db();
  d.run(
    `INSERT INTO trades (id, account, symbol, currency, direction, status, open_time, avg_entry, max_qty, fees, coverage_ok, effective_stop)
     VALUES ('t1','a','US.AAPL','USD','LONG','open', 1000, 100, 10, 0, 1, 95)`,
  );
  insertPositionSnapshot(d, [
    { account: "a", symbol: "US.AAPL", qty: 10, avgCost: 100, currency: "USD", time: 5000 },
  ]);
  const { byCurrency } = openPositionsByCurrency(d, 5000);
  expect(byCurrency[0]!.totalOpenRisk).toBeCloseTo(50);
  expect(byCurrency[0]!.equity).toBeNull();
  expect(byCurrency[0]!.riskPct).toBeNull();
});

test("tradeDetail expresses planned risk as % of equity at open (same currency), null without a snapshot", () => {
  const d = db();
  d.run(
    `INSERT INTO trades (id, account, symbol, currency, direction, status, open_time, close_time, avg_entry, avg_exit, max_qty, realized_pnl, fees, coverage_ok, effective_stop, risk, r_multiple)
     VALUES ('t1','a','US.AAPL','USD','LONG','closed', 1000, 2000, 100, 110, 10, 100, 0, 1, 95, 50, 2)`,
  );
  // No funds yet → riskPct null, basis "none".
  const bare = tradeDetail(d, "t1")!;
  expect(bare.riskPct).toBeNull();
  expect(bare.equityBasis).toBe("none");
  // Snapshot BEFORE open (t=900 < 1000) → precise "at_open" basis.
  insertFunds(d, { account: "a", currency: "USD", totalAssets: 10_000, cash: 0, marketVal: 0, time: 900 });
  const det = tradeDetail(d, "t1")!;
  expect(det.accountEquity).toBe(10_000);
  expect(det.equityBasis).toBe("at_open");
  expect(det.riskPct).toBeCloseTo(0.005); // risk 50 / equity 10000
});

test("tradeDetail falls back to latest equity (approximate) when none precedes the open", () => {
  const d = db();
  d.run(
    `INSERT INTO trades (id, account, symbol, currency, direction, status, open_time, close_time, avg_entry, avg_exit, max_qty, realized_pnl, fees, coverage_ok, effective_stop, risk, r_multiple)
     VALUES ('t1','a','US.AAPL','USD','LONG','closed', 1000, 2000, 100, 110, 10, 100, 0, 1, 95, 50, 2)`,
  );
  // Only a snapshot AFTER the open exists → no at-open equity, approximate with latest.
  insertFunds(d, { account: "a", currency: "USD", totalAssets: 20_000, cash: 0, marketVal: 0, time: 5000 });
  const det = tradeDetail(d, "t1")!;
  expect(det.equityBasis).toBe("latest");
  expect(det.accountEquity).toBe(20_000);
  expect(det.riskPct).toBeCloseTo(50 / 20_000);
});

test("tradeDetail reports the current holding from the latest snapshot for an open trade", () => {
  const d = db();
  d.run(
    `INSERT INTO trades (id, account, symbol, currency, direction, status, open_time, avg_entry, max_qty, fees, coverage_ok, effective_stop, risk)
     VALUES ('t1','a','US.AAPL','USD','LONG','open', 1000, 100, 10, 0, 1, 95, 50)`,
  );
  insertPositionSnapshot(d, [
    { account: "a", symbol: "US.AAPL", qty: 6, avgCost: 100, currency: "USD", time: 5000 }, // scaled out to 6
  ]);
  const det = tradeDetail(d, "t1")!;
  expect(det.currentQty).toBe(6); // from the snapshot, NOT max_qty (10)
  expect(det.positionAsOf).toBe(5000);
});

test("tradeDetail current holding is 0 for a closed trade and when no snapshot matches", () => {
  const d = db();
  d.run(
    `INSERT INTO trades (id, account, symbol, currency, direction, status, open_time, close_time, avg_entry, avg_exit, max_qty, realized_pnl, fees, coverage_ok)
     VALUES ('t1','a','US.AAPL','USD','LONG','closed', 1000, 2000, 100, 110, 10, 100, 0, 1)`,
  );
  // A snapshot exists for a DIFFERENT symbol; the closed trade must still report flat.
  insertPositionSnapshot(d, [
    { account: "a", symbol: "US.MSFT", qty: 3, avgCost: 300, currency: "USD", time: 5000 },
  ]);
  expect(tradeDetail(d, "t1")!.currentQty).toBe(0);
});

test("latestSnapshotTime prefers the marker, backfilling from stored snapshots when it's absent", () => {
  const d = db();
  // Migrated (pre-marker) DB: no marker, but raw_positions has the last sync batch → use MAX(time).
  insertPositionSnapshot(d, [
    { account: "a", symbol: "US.AAPL", qty: 1, avgCost: 1, currency: "USD", time: 4000 },
  ]);
  expect(latestSnapshotTime(d)).toBe(4000);
  // A migrated DB whose LAST sync was all-flat wrote no raw_positions row for that batch — prefer the
  // sync clock (sync_state) so we don't resurrect the older non-empty snapshot at t=4000.
  d.run(
    `INSERT INTO sync_state (account, market, last_synced_time, coverage_start) VALUES ('a','US',7000,0)`,
  );
  expect(latestSnapshotTime(d)).toBe(7000);
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
