# Persistence Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the pure core a place to live — SQLite repositories that persist raw FUTU data, rebuild derived trades/flags idempotently, and read/write rule config + sync state.

**Architecture:** Two tiers, matching the spec (§5). **Raw** tables (`raw_fills`, `raw_orders`, `raw_positions`) are upserted from FUTU and never mutated by logic. **Derived** tables (`trades`, `trade_fills`, `flags`) are dropped-and-rebuilt from raw on every sync, so a full-replace is the correct write path. `config` and `sync_state` are small key-value/row stores. All functions take an already-open `Database` (from `openDb` + `runMigrations`); none open connections or do I/O beyond SQLite, so every one is testable against an in-memory DB.

**Tech Stack:** Bun + `bun:sqlite`, TypeScript strict (`noUncheckedIndexedAccess`), `bun test`.

---

## File Structure

- **Create** `src/store/repos.ts` — raw upserts, raw reads, and derived replace/read.
- **Create** `src/store/config.ts` — rule-config get/set over the `config` key-value table.
- **Create** `src/store/sync-state.ts` — per-(account, market) sync cursor get/upsert.
- **Modify** `src/domain/types.ts` — add the `RawPosition` (stored snapshot) and `SyncState` interfaces.
- **Create** `test/store/repos.test.ts`, `test/store/config.test.ts`, `test/store/sync-state.test.ts`.
- **Modify** `test/helpers.ts` — add a `rawPos` builder + an `openTestDb()` helper.

The migrations in `src/store/migrations.ts` already create every table this plan writes to (v1–v3). **Do not add migrations** — only read/write existing tables. If a column is missing, that is a bug in this plan; stop and re-read the migration rather than adding a migration.

### Table ↔ domain field mapping (snake_case column ↔ camelCase field)

`raw_fills` ↔ `RawFill`: `id, order_id↔orderId, symbol, side, qty, price, fee, currency, time, account`.
`raw_orders` ↔ `RawOrder`: `id, symbol, side, type, qty, price, trigger_price↔triggerPrice, status, create_time↔createTime, update_time↔updateTime, account`.
`raw_positions` ↔ `RawPosition`: `account, symbol, qty, avg_cost↔avgCost, currency, time` (PK `(account, symbol, time)`).
`trades` ↔ `Trade`: `id, account, symbol, currency, direction, status, open_time↔openTime, close_time↔closeTime, avg_entry↔avgEntry, avg_exit↔avgExit, max_qty↔maxQty, realized_pnl↔realizedPnl, fees, hold_seconds↔holdSeconds, coverage_ok↔coverageOk, effective_stop↔effectiveStop, effective_tp↔effectiveTp, risk, r_multiple↔rMultiple, mae, mfe`.
`trade_fills`: `trade_id↔Trade.id, fill_id↔each of Trade.fillIds`.
`flags` ↔ `Flag`: `trade_id↔Trade.id, rule_id↔ruleId, severity, reason`.
`config`: `key, value` (value is a JSON string).
`sync_state` ↔ `SyncState`: `account, market, last_synced_time↔lastSyncedTime, coverage_start↔coverageStart`.

**Booleans:** SQLite stores `coverage_ok` as `INTEGER` (1/0). Write `t.coverageOk ? 1 : 0`; read `row.coverage_ok === 1`.
**Nulls:** `null` domain fields map to SQL `NULL` directly (bun:sqlite binds `null`). Read them back as `?? null` guarded values, never coercing `null`→`0`.

---

## Task 1: Domain types + test helpers

**Files:**
- Modify: `src/domain/types.ts`
- Modify: `test/helpers.ts`

- [ ] **Step 1: Add the `RawPosition` and `SyncState` interfaces to `src/domain/types.ts`**

Add after the `SeedPosition` interface (they are structurally similar but semantically distinct — `SeedPosition` feeds the trade-builder; `RawPosition` is a stored snapshot row):

```ts
/** A stored position snapshot row (raw_positions). One per (account, symbol, snapshot time). */
export interface RawPosition {
  account: string;
  symbol: string;
  qty: number; // signed: positive = long, negative = short
  avgCost: number;
  currency: string;
  time: number; // epoch ms of the snapshot
}

/** Sync cursor for one (account, market). Persisted so re-syncs are incremental. */
export interface SyncState {
  account: string;
  market: string;
  lastSyncedTime: number | null; // epoch ms of the newest raw row pulled so far
  coverageStart: number | null; // epoch ms of the oldest raw row we have (history floor)
}
```

- [ ] **Step 2: Add helpers to `test/helpers.ts`**

Append:

```ts
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/store/migrations";
import type { RawPosition } from "../src/domain/types";

/** An in-memory DB with the full schema migrated — the base for every store test. */
export function openTestDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON;");
  runMigrations(db);
  return db;
}

/** Concise position-snapshot builder. `qty` is signed (+long / -short). */
export function rawPos(qty: number, avgCost: number, over: Partial<RawPosition> = {}): RawPosition {
  return {
    account: over.account ?? "acc1",
    symbol: over.symbol ?? "AAPL",
    qty,
    avgCost,
    currency: over.currency ?? "USD",
    time: over.time ?? 1000,
  };
}
```

Keep the existing `import type { ... }` at the top of the file; add `RawPosition` there rather than duplicating the import if the linter objects to two type-import lines from the same module. Match the file's existing style.

- [ ] **Step 3: Verify it compiles**

Run: `bunx tsc --noEmit`
Expected: clean (no errors). The helpers are unused so far — that's fine, they're referenced in later tasks.

- [ ] **Step 4: Commit**

```bash
git add src/domain/types.ts test/helpers.ts
git commit -m "feat(store): add RawPosition/SyncState types + test db helpers"
```

---

## Task 2: Raw repositories (upserts + reads)

**Files:**
- Create: `src/store/repos.ts`
- Test: `test/store/repos.test.ts`

- [ ] **Step 1: Write failing tests for raw upserts + reads**

Create `test/store/repos.test.ts`:

```ts
import { test, expect } from "bun:test";
import { openTestDb, fill, order, rawPos } from "../helpers";
import {
  upsertRawFills,
  upsertRawOrders,
  insertPositionSnapshot,
  allRawFills,
  allRawOrders,
  latestPositions,
} from "../../src/store/repos";

test("upsertRawFills inserts and reads back, ordered by time", () => {
  const db = openTestDb();
  upsertRawFills(db, [fill("BUY", 100, 10, { id: "f2", time: 2000 }), fill("SELL", 100, 11, { id: "f1", time: 1000 })]);
  const rows = allRawFills(db);
  expect(rows.map((r) => r.id)).toEqual(["f1", "f2"]); // time-ordered
  expect(rows[0]!.side).toBe("SELL");
  expect(rows[1]!.price).toBe(10);
});

test("upsertRawFills is idempotent — re-inserting the same id updates, never duplicates", () => {
  const db = openTestDb();
  upsertRawFills(db, [fill("BUY", 100, 10, { id: "f1", price: 10 })]);
  upsertRawFills(db, [fill("BUY", 100, 10, { id: "f1", price: 12 })]); // same id, new price
  const rows = allRawFills(db);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.price).toBe(12); // last write wins
});

test("upsertRawOrders round-trips nullable price/triggerPrice/updateTime", () => {
  const db = openTestDb();
  upsertRawOrders(db, [
    order("SELL", "STOP", 100, { id: "o1", price: null, triggerPrice: 9, updateTime: null, createTime: 1000 }),
    order("BUY", "LIMIT", 50, { id: "o2", price: 8, triggerPrice: null, updateTime: 2000, createTime: 1500 }),
  ]);
  const rows = allRawOrders(db);
  expect(rows.map((r) => r.id)).toEqual(["o1", "o2"]); // createTime-ordered
  expect(rows[0]!.price).toBeNull();
  expect(rows[0]!.triggerPrice).toBe(9);
  expect(rows[0]!.updateTime).toBeNull();
  expect(rows[1]!.updateTime).toBe(2000);
});

test("insertPositionSnapshot keeps one row per (account,symbol,time); latestPositions returns newest per symbol", () => {
  const db = openTestDb();
  insertPositionSnapshot(db, [rawPos(100, 10, { symbol: "AAPL", time: 1000 })]);
  insertPositionSnapshot(db, [rawPos(150, 10.5, { symbol: "AAPL", time: 2000 })]); // newer snapshot
  insertPositionSnapshot(db, [rawPos(-20, 300, { symbol: "TSLA", time: 1500 })]);
  const latest = latestPositions(db);
  const aapl = latest.find((p) => p.symbol === "AAPL")!;
  expect(aapl.qty).toBe(150); // the 2000 snapshot, not the 1000 one
  expect(aapl.avgCost).toBe(10.5);
  expect(latest.find((p) => p.symbol === "TSLA")!.qty).toBe(-20);
});

test("insertPositionSnapshot re-inserting the same (account,symbol,time) replaces, not duplicates", () => {
  const db = openTestDb();
  insertPositionSnapshot(db, [rawPos(100, 10, { time: 1000 })]);
  insertPositionSnapshot(db, [rawPos(120, 10, { time: 1000 })]); // same key
  expect(latestPositions(db)).toHaveLength(1);
  expect(latestPositions(db)[0]!.qty).toBe(120);
});

test("empty reads return empty arrays", () => {
  const db = openTestDb();
  expect(allRawFills(db)).toEqual([]);
  expect(allRawOrders(db)).toEqual([]);
  expect(latestPositions(db)).toEqual([]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/store/repos.test.ts`
Expected: FAIL — `Cannot find module '../../src/store/repos'`.

- [ ] **Step 3: Implement the raw repositories**

Create `src/store/repos.ts` (raw section — the derived section is added in Task 3):

```ts
import type { Database } from "bun:sqlite";
import type { Flag, RawFill, RawOrder, RawPosition, Trade } from "../domain/types";

// ---- raw_fills ----------------------------------------------------------------

export function upsertRawFills(db: Database, fills: RawFill[]): void {
  const stmt = db.prepare(
    `INSERT INTO raw_fills (id, order_id, symbol, side, qty, price, fee, currency, time, account)
     VALUES ($id, $orderId, $symbol, $side, $qty, $price, $fee, $currency, $time, $account)
     ON CONFLICT(id) DO UPDATE SET
       order_id=$orderId, symbol=$symbol, side=$side, qty=$qty, price=$price, fee=$fee,
       currency=$currency, time=$time, account=$account`,
  );
  db.transaction(() => {
    for (const f of fills) {
      stmt.run({
        $id: f.id, $orderId: f.orderId, $symbol: f.symbol, $side: f.side, $qty: f.qty,
        $price: f.price, $fee: f.fee, $currency: f.currency, $time: f.time, $account: f.account,
      });
    }
  })();
}

export function allRawFills(db: Database): RawFill[] {
  const rows = db
    .query(`SELECT id, order_id, symbol, side, qty, price, fee, currency, time, account
            FROM raw_fills ORDER BY time ASC, id ASC`)
    .all() as any[];
  return rows.map((r) => ({
    id: r.id, orderId: r.order_id, symbol: r.symbol, side: r.side, qty: r.qty, price: r.price,
    fee: r.fee, currency: r.currency, time: r.time, account: r.account,
  }));
}

// ---- raw_orders ---------------------------------------------------------------

export function upsertRawOrders(db: Database, orders: RawOrder[]): void {
  const stmt = db.prepare(
    `INSERT INTO raw_orders (id, symbol, side, type, qty, price, trigger_price, status, create_time, update_time, account)
     VALUES ($id, $symbol, $side, $type, $qty, $price, $trigger, $status, $create, $update, $account)
     ON CONFLICT(id) DO UPDATE SET
       symbol=$symbol, side=$side, type=$type, qty=$qty, price=$price, trigger_price=$trigger,
       status=$status, create_time=$create, update_time=$update, account=$account`,
  );
  db.transaction(() => {
    for (const o of orders) {
      stmt.run({
        $id: o.id, $symbol: o.symbol, $side: o.side, $type: o.type, $qty: o.qty,
        $price: o.price, $trigger: o.triggerPrice, $status: o.status,
        $create: o.createTime, $update: o.updateTime, $account: o.account,
      });
    }
  })();
}

export function allRawOrders(db: Database): RawOrder[] {
  const rows = db
    .query(`SELECT id, symbol, side, type, qty, price, trigger_price, status, create_time, update_time, account
            FROM raw_orders ORDER BY create_time ASC, id ASC`)
    .all() as any[];
  return rows.map((r) => ({
    id: r.id, symbol: r.symbol, side: r.side, type: r.type, qty: r.qty, price: r.price,
    triggerPrice: r.trigger_price, status: r.status, createTime: r.create_time,
    updateTime: r.update_time, account: r.account,
  }));
}

// ---- raw_positions ------------------------------------------------------------

export function insertPositionSnapshot(db: Database, rows: RawPosition[]): void {
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO raw_positions (account, symbol, qty, avg_cost, currency, time)
     VALUES ($account, $symbol, $qty, $avgCost, $currency, $time)`,
  );
  db.transaction(() => {
    for (const p of rows) {
      stmt.run({
        $account: p.account, $symbol: p.symbol, $qty: p.qty, $avgCost: p.avgCost,
        $currency: p.currency, $time: p.time,
      });
    }
  })();
}

/** The most recent snapshot per (account, symbol). */
export function latestPositions(db: Database): RawPosition[] {
  const rows = db
    .query(`SELECT account, symbol, qty, avg_cost, currency, time FROM raw_positions p
            WHERE time = (SELECT MAX(time) FROM raw_positions q WHERE q.account = p.account AND q.symbol = p.symbol)
            ORDER BY account ASC, symbol ASC`)
    .all() as any[];
  return rows.map((r) => ({
    account: r.account, symbol: r.symbol, qty: r.qty, avgCost: r.avg_cost,
    currency: r.currency, time: r.time,
  }));
}
```

Note on `any[]`: bun:sqlite returns untyped rows; the explicit `.map` is the typed boundary. This mirrors how the rest of the codebase would read rows — keep the map exhaustive so a missing column surfaces as `undefined` in a test, not a silent type lie.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/store/repos.test.ts`
Expected: PASS (all 6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/store/repos.ts test/store/repos.test.ts
git commit -m "feat(store): raw_fills/raw_orders/raw_positions repositories"
```

---

## Task 3: Derived replace + read (trades, trade_fills, flags)

**Files:**
- Modify: `src/store/repos.ts`
- Modify: `test/store/repos.test.ts`

- [ ] **Step 1: Add failing tests for derived replace/read**

Append to `test/store/repos.test.ts` (add the imports `replaceDerived, allTrades, flagsForTrade` to the existing import from `../../src/store/repos`, and `import type { Flag, Trade } from "../../src/domain/types";`):

```ts
function tradeFixture(over: Partial<Trade> = {}): Trade {
  return {
    id: over.id ?? "acc1:AAPL:1000:f1",
    account: "acc1", symbol: "AAPL", currency: "USD", direction: "LONG", status: "closed",
    openTime: 1000, closeTime: 2000, avgEntry: 10, avgExit: 11, maxQty: 100,
    realizedPnl: 100, fees: 1, holdSeconds: 1, coverageOk: true, fillIds: ["f1", "f2"],
    effectiveStop: 9, effectiveTp: null, risk: 100, rMultiple: 1, mae: 0.5, mfe: 2,
    ...over,
  };
}

test("replaceDerived writes trades, their fill links, and flags", () => {
  const db = openTestDb();
  const t = tradeFixture();
  const flags: Flag[] = [{ ruleId: "cut_winner_early", severity: "warn", reason: "left money" }];
  replaceDerived(db, [t], new Map([[t.id, flags]]));

  const got = allTrades(db);
  expect(got).toHaveLength(1);
  expect(got[0]!.id).toBe(t.id);
  expect(got[0]!.coverageOk).toBe(true);
  expect(got[0]!.effectiveStop).toBe(9);
  expect(got[0]!.effectiveTp).toBeNull();
  expect(got[0]!.fillIds.sort()).toEqual(["f1", "f2"]);
  expect(flagsForTrade(db, t.id)).toEqual(flags);
});

test("replaceDerived fully replaces prior derived data (idempotent rebuild)", () => {
  const db = openTestDb();
  const a = tradeFixture({ id: "a", fillIds: ["fa"] });
  replaceDerived(db, [a], new Map([["a", [{ ruleId: "oversized", severity: "warn", reason: "big" }]]]));
  // Second rebuild with a different trade set — the first must be gone entirely.
  const b = tradeFixture({ id: "b", fillIds: ["fb"] });
  replaceDerived(db, [b], new Map());

  expect(allTrades(db).map((t) => t.id)).toEqual(["b"]);
  expect(flagsForTrade(db, "a")).toEqual([]); // old flags wiped
  expect(flagsForTrade(db, "b")).toEqual([]);
});

test("replaceDerived round-trips an open trade with null exit/pnl/enrichment", () => {
  const db = openTestDb();
  const open = tradeFixture({
    id: "open", status: "open", closeTime: null, avgExit: null, realizedPnl: null,
    holdSeconds: null, coverageOk: false, effectiveStop: null, risk: null, rMultiple: null,
    mae: null, mfe: null, fillIds: ["fo"],
  });
  replaceDerived(db, [open], new Map());
  const got = allTrades(db)[0]!;
  expect(got.status).toBe("open");
  expect(got.closeTime).toBeNull();
  expect(got.realizedPnl).toBeNull();
  expect(got.coverageOk).toBe(false);
  expect(got.mae).toBeNull();
});

test("allTrades returns trades ordered by open_time then id", () => {
  const db = openTestDb();
  replaceDerived(
    db,
    [tradeFixture({ id: "late", openTime: 5000 }), tradeFixture({ id: "early", openTime: 1000 })],
    new Map(),
  );
  expect(allTrades(db).map((t) => t.id)).toEqual(["early", "late"]);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/store/repos.test.ts`
Expected: FAIL — `replaceDerived is not a function` (or import error).

- [ ] **Step 3: Implement the derived section of `src/store/repos.ts`**

Append to `src/store/repos.ts`:

```ts
// ---- derived: trades + trade_fills + flags ------------------------------------

/** Fully replace all derived data. Derived tables are rebuildable from raw, so each sync
 * wipes and re-writes them in a single transaction — no partial/stale rows can survive. */
export function replaceDerived(db: Database, trades: Trade[], flags: Map<string, Flag[]>): void {
  const insTrade = db.prepare(
    `INSERT INTO trades
       (id, account, symbol, currency, direction, status, open_time, close_time, avg_entry,
        avg_exit, max_qty, realized_pnl, fees, hold_seconds, coverage_ok,
        effective_stop, effective_tp, risk, r_multiple, mae, mfe)
     VALUES
       ($id, $account, $symbol, $currency, $direction, $status, $openTime, $closeTime, $avgEntry,
        $avgExit, $maxQty, $realizedPnl, $fees, $holdSeconds, $coverageOk,
        $effectiveStop, $effectiveTp, $risk, $rMultiple, $mae, $mfe)`,
  );
  const insLink = db.prepare(`INSERT INTO trade_fills (trade_id, fill_id) VALUES ($t, $f)`);
  const insFlag = db.prepare(
    `INSERT INTO flags (trade_id, rule_id, severity, reason) VALUES ($t, $rule, $sev, $reason)`,
  );

  db.transaction(() => {
    db.run("DELETE FROM flags;");
    db.run("DELETE FROM trade_fills;");
    db.run("DELETE FROM trades;");
    for (const t of trades) {
      insTrade.run({
        $id: t.id, $account: t.account, $symbol: t.symbol, $currency: t.currency,
        $direction: t.direction, $status: t.status, $openTime: t.openTime, $closeTime: t.closeTime,
        $avgEntry: t.avgEntry, $avgExit: t.avgExit, $maxQty: t.maxQty, $realizedPnl: t.realizedPnl,
        $fees: t.fees, $holdSeconds: t.holdSeconds, $coverageOk: t.coverageOk ? 1 : 0,
        $effectiveStop: t.effectiveStop, $effectiveTp: t.effectiveTp, $risk: t.risk,
        $rMultiple: t.rMultiple, $mae: t.mae, $mfe: t.mfe,
      });
      for (const fid of t.fillIds) insLink.run({ $t: t.id, $f: fid });
      for (const fl of flags.get(t.id) ?? []) {
        insFlag.run({ $t: t.id, $rule: fl.ruleId, $sev: fl.severity, $reason: fl.reason });
      }
    }
  })();
}

export function allTrades(db: Database): Trade[] {
  const rows = db
    .query(`SELECT * FROM trades ORDER BY open_time ASC, id ASC`)
    .all() as any[];
  const links = db.query(`SELECT trade_id, fill_id FROM trade_fills`).all() as any[];
  const byTrade = new Map<string, string[]>();
  for (const l of links) {
    let arr = byTrade.get(l.trade_id);
    if (!arr) { arr = []; byTrade.set(l.trade_id, arr); }
    arr.push(l.fill_id);
  }
  return rows.map((r) => ({
    id: r.id, account: r.account, symbol: r.symbol, currency: r.currency, direction: r.direction,
    status: r.status, openTime: r.open_time, closeTime: r.close_time, avgEntry: r.avg_entry,
    avgExit: r.avg_exit, maxQty: r.max_qty, realizedPnl: r.realized_pnl, fees: r.fees,
    holdSeconds: r.hold_seconds, coverageOk: r.coverage_ok === 1,
    fillIds: byTrade.get(r.id) ?? [],
    effectiveStop: r.effective_stop, effectiveTp: r.effective_tp, risk: r.risk,
    rMultiple: r.r_multiple, mae: r.mae, mfe: r.mfe,
  }));
}

export function flagsForTrade(db: Database, tradeId: string): Flag[] {
  const rows = db
    .query(`SELECT rule_id, severity, reason FROM flags WHERE trade_id = ? ORDER BY rule_id ASC`)
    .all(tradeId) as any[];
  return rows.map((r) => ({ ruleId: r.rule_id, severity: r.severity, reason: r.reason }));
}
```

**Important:** `flagsForTrade` sorts by `rule_id`; the "writes … flags" test has a single flag so order is irrelevant, but keep the sort so multi-flag reads are deterministic. If a future test asserts insertion order, revisit.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/store/repos.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Full test + typecheck**

Run: `bun test && bunx tsc --noEmit`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/store/repos.ts test/store/repos.test.ts
git commit -m "feat(store): derived trades/flags full-replace + reads"
```

---

## Task 4: Rule-config store

**Files:**
- Create: `src/store/config.ts`
- Test: `test/store/config.test.ts`

- [ ] **Step 1: Write failing tests**

Create `test/store/config.test.ts`:

```ts
import { test, expect } from "bun:test";
import { openTestDb } from "../helpers";
import { getRuleConfig, setRuleConfig } from "../../src/store/config";
import { DEFAULT_RULE_CONFIG } from "../../src/domain/types";

test("getRuleConfig returns defaults when nothing is stored", () => {
  const db = openTestDb();
  expect(getRuleConfig(db)).toEqual(DEFAULT_RULE_CONFIG);
});

test("setRuleConfig persists and getRuleConfig reads it back", () => {
  const db = openTestDb();
  const cfg = { ...DEFAULT_RULE_CONFIG, oversizedMult: 2, enabled: { cut_winner_early: false } };
  setRuleConfig(db, cfg);
  expect(getRuleConfig(db)).toEqual(cfg);
});

test("getRuleConfig merges stored overrides onto defaults (new default keys survive)", () => {
  const db = openTestDb();
  // Simulate an older stored config missing a field that later became a default.
  db.run("INSERT INTO config (key, value) VALUES ('rules', ?)", [
    JSON.stringify({ oversizedMult: 3 }),
  ]);
  const cfg = getRuleConfig(db);
  expect(cfg.oversizedMult).toBe(3); // stored override wins
  expect(cfg.cutWinnerR).toBe(DEFAULT_RULE_CONFIG.cutWinnerR); // absent → default
  expect(cfg.enabled).toEqual({}); // absent → default
});

test("setRuleConfig overwrites the previous value (single row)", () => {
  const db = openTestDb();
  setRuleConfig(db, { ...DEFAULT_RULE_CONFIG, roundTripR: 2 });
  setRuleConfig(db, { ...DEFAULT_RULE_CONFIG, roundTripR: 5 });
  expect(getRuleConfig(db).roundTripR).toBe(5);
  const count = db.query("SELECT COUNT(*) AS n FROM config WHERE key='rules'").get() as { n: number };
  expect(count.n).toBe(1);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/store/config.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/store/config.ts`**

```ts
import type { Database } from "bun:sqlite";
import { DEFAULT_RULE_CONFIG, type RuleConfig } from "../domain/types";

const RULES_KEY = "rules";

/** Read the rule config, shallow-merging any stored overrides onto the current defaults so a
 * config written by an older version still gains newly-added default fields. */
export function getRuleConfig(db: Database): RuleConfig {
  const row = db.query("SELECT value FROM config WHERE key = ?").get(RULES_KEY) as
    | { value: string }
    | null;
  if (!row) return { ...DEFAULT_RULE_CONFIG };
  const stored = JSON.parse(row.value) as Partial<RuleConfig>;
  return {
    ...DEFAULT_RULE_CONFIG,
    ...stored,
    enabled: { ...DEFAULT_RULE_CONFIG.enabled, ...(stored.enabled ?? {}) },
  };
}

export function setRuleConfig(db: Database, config: RuleConfig): void {
  db.run(
    `INSERT INTO config (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [RULES_KEY, JSON.stringify(config)],
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/store/config.test.ts`
Expected: PASS (all 4).

- [ ] **Step 5: Commit**

```bash
git add src/store/config.ts test/store/config.test.ts
git commit -m "feat(store): rule-config key-value store with default merge"
```

---

## Task 5: Sync-state store

**Files:**
- Create: `src/store/sync-state.ts`
- Test: `test/store/sync-state.test.ts`

- [ ] **Step 1: Write failing tests**

Create `test/store/sync-state.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/store/sync-state.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/store/sync-state.ts`**

```ts
import type { Database } from "bun:sqlite";
import type { SyncState } from "../domain/types";

export function getSyncState(db: Database, account: string, market: string): SyncState | null {
  const row = db
    .query(`SELECT account, market, last_synced_time, coverage_start
            FROM sync_state WHERE account = ? AND market = ?`)
    .get(account, market) as any;
  if (!row) return null;
  return {
    account: row.account,
    market: row.market,
    lastSyncedTime: row.last_synced_time ?? null,
    coverageStart: row.coverage_start ?? null,
  };
}

export function upsertSyncState(db: Database, s: SyncState): void {
  db.run(
    `INSERT INTO sync_state (account, market, last_synced_time, coverage_start)
     VALUES ($account, $market, $last, $cov)
     ON CONFLICT(account, market) DO UPDATE SET
       last_synced_time = excluded.last_synced_time,
       coverage_start = excluded.coverage_start`,
    { $account: s.account, $market: s.market, $last: s.lastSyncedTime, $cov: s.coverageStart },
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/store/sync-state.test.ts`
Expected: PASS (all 5).

- [ ] **Step 5: Full suite + typecheck**

Run: `bun test && bunx tsc --noEmit`
Expected: all green (prior 75 + the new store tests).

- [ ] **Step 6: Commit**

```bash
git add src/store/sync-state.ts test/store/sync-state.test.ts
git commit -m "feat(store): per-(account,market) sync-state cursor"
```

---

## Done criteria

- `bun test` green; `bunx tsc --noEmit` clean.
- `src/store/repos.ts`, `config.ts`, `sync-state.ts` cover every table except migrations' bookkeeping.
- Raw upserts are idempotent (re-sync safe); derived data is full-replace (rebuild safe); user-written tables (`journal*`, `attachments`, `watchlist_items`) are untouched by this layer — they arrive in a later plan.
- No live FUTU or network dependency anywhere in this plan.

**Next plan (Plan 5 — Ingest & sync):** `futu-client` mappers (proto field names + enums already captured in the Plan 5 draft), the live OpenD client, the single candle source, and the `runSync` orchestrator that wires this persistence layer to the pure core. That plan deletes `src/futu/spike.ts`.
