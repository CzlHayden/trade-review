# Plan 6 — API & Journaling Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the persistence + HTTP layer the web UI (Plan 7) consumes: journaling tables, a candle cache, a split sync pipeline, and a `Bun.serve` JSON API served from one compiled binary.

**Architecture:** A single Bun process binds `127.0.0.1`, serves a JSON API over the existing pure core + store, and serves the built SPA static (placeholder for now). Derived data (`trades`/`flags`) is still fully rebuilt from raw on every sync, so **user-written journal tables must be orphan-tolerant** (`trade_id TEXT`, no FK to `trades`) and survive rebuilds. `runSync` splits into `pullRaw` (touches OpenD) + `rebuildDerived` (pure-pipeline only) so journal manual-stop edits and rule-config changes re-derive risk/R/flags **through the single 147-test-covered pipeline** without touching OpenD.

**Tech Stack:** Bun (`Bun.serve` native routing, `bun:sqlite`, `bun test`), TypeScript strict + `noUncheckedIndexedAccess`. No web framework, no router library. API tests call the fetch handler directly against an in-memory DB.

---

## Load-bearing decisions (do not deviate without escalating)

1. **Orphan-tolerant journal.** Journal tables key on `trade_id TEXT` / `entry_id` with **NO foreign key to `trades`** (which is `DELETE`d wholesale every rebuild — see `src/store/repos.ts:105` `replaceDerived`). Journals join to trades at read time; an orphaned journal is preserved and readable, never garbage-collected. Task 2 ships a fixture test: *write journal → run full rebuild → journal intact and still attached*.
2. **Split pipeline.** `runSync` = `pullRaw(db, client, {now, historyDays})` then `rebuildDerived(db, {candles, config, now})`. `rebuildDerived` is the existing `sync.ts:153–218` body. Manual-stop edits (Task 7) and rule-config edits call **`rebuildDerived` only** — never OpenD.
3. **Manual stop overrides inferred.** A user-entered `manual_stop` is an explicit assertion of their risk and is authoritative over the order-inferred stop for `risk`/`rMultiple`/flags. It flows in through `rebuildDerived`, so the whole pipeline recomputes consistently.
4. **Candle cache = `CandleSource` decorator.** `cachedCandles(db, yahooCandles)` implements the existing `CandleSource` port. Sync writes bars it already fetches; the chart endpoint reads through the same decorator. The pure core never knows.
5. **Currency safety across the wire.** Every *aggregate* money field ships under a `byCurrency` array — never a bare top-level number. Plan rule for Plan 7: the frontend never computes a money aggregate; anything aggregated on screen arrives from the API (i.e. from `analytics.ts`).
6. **Localhost only.** `Bun.serve({ hostname: "127.0.0.1" })`. That bind is the entire security model — no auth, no CORS, no versioning.
7. **Timezone rule (declare once).** Week boundaries and hold-time buckets use the **machine-local** timezone (documented in `src/domain/time.ts`). Written down so weekly-journal date association is deterministic.

---

## File Structure

- Create `src/store/journal.ts` — per-trade journal + tags + weekly entry + watchlist repos.
- Create `src/store/candles-cache.ts` — `cachedCandles` decorator + cache read/write repos.
- Create `src/domain/journal-types.ts` — `Journal`, `JournalTag`, `WeeklyEntry`, `WatchlistItem` shapes.
- Create `src/domain/time.ts` — `isoWeekOf(ms)`, `weekRange(isoWeek)`, `holdBucket(seconds)` (the one timezone home).
- Modify `src/store/migrations.ts` — append migration v4 (append-only; never edit v1–v3).
- Modify `src/sync/sync.ts` — extract `pullRaw` + `rebuildDerived` from `runSync`; `rebuildDerived` reads journal manual stops.
- Modify `src/sync/run.ts` — call the new decorator + split functions (behavior unchanged).
- Create `src/api/routes.ts` — pure route handlers: `buildApi(db, deps) → (req: Request) => Promise<Response>`.
- Create `src/api/views.ts` — read-model assemblers (trade detail, positions, meta) over existing repos.
- Create `src/api/sync-runner.ts` — in-process sync mutex + persisted status.
- Create `src/api/static.ts` — SPA static serving + history fallback.
- Create `src/app.ts` — bootstrap: backup → migrate → serve → open browser. (`package.json` already points `module` here.)
- Create `web/index.html` — placeholder shell (Plan 7 replaces it).
- Tests mirror each under `test/…`.

---

## Task 1: Migration v4 — journal + candle-cache tables

**Files:**
- Modify: `src/store/migrations.ts` (append one entry to `MIGRATIONS`)
- Test: `test/store/migrations-v4.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
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
  for (const t of ["journal", "journal_tags", "journal_entries", "watchlist_items", "candles_cache", "candle_coverage"]) {
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
  expect((db.query(`SELECT trade_id FROM journal`).all() as any[])).toHaveLength(1);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/store/migrations-v4.test.ts`
Expected: FAIL — `no such table: journal`.

- [ ] **Step 3: Append migration v4**

Append to the `MIGRATIONS` array in `src/store/migrations.ts` (after the v3 entry — never edit shipped entries):

```ts
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test test/store/migrations-v4.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store/migrations.ts test/store/migrations-v4.test.ts
git commit -m "feat(store): add v4 migration — journal + candle-cache tables (orphan-tolerant)"
```

---

## Task 2: Journal repos + the rebuild-survival invariant

**Files:**
- Create: `src/domain/journal-types.ts`
- Create: `src/domain/time.ts`
- Create: `src/store/journal.ts`
- Test: `test/store/journal.test.ts`, `test/domain/time.test.ts`

- [ ] **Step 1: Write `src/domain/journal-types.ts`**

```ts
/** Per-trade journal. All fields optional except the linkage + timestamp. */
export interface Journal {
  tradeId: string;
  thesis: string | null;
  emotion: string | null;
  conviction: number | null; // 1..5
  rating: number | null;     // 1..5
  notes: string | null;      // markdown
  manualStop: number | null; // authoritative over inferred stop (see Plan 6 decision 3)
  setup: string | null;      // single-select, drives "by setup" analytics
  tags: string[];            // freeform multi
  updatedAt: number;
}

/** Optional weekly journal entry + its watchlist. Trades are associated by date, never stored. */
export interface WeeklyEntry {
  id: string;          // ISO week key "YYYY-Www"
  periodStart: number; // epoch ms inclusive
  periodEnd: number;   // epoch ms exclusive
  marketRead: string | null;
  tradedVsPlan: string | null;
  watchlist: WatchlistItem[];
  updatedAt: number;
}

export interface WatchlistItem {
  symbol: string;
  note: string | null;
  keyLevel: number | null;
}
```

- [ ] **Step 2: Write the failing test for `src/domain/time.ts`**

```ts
import { test, expect } from "bun:test";
import { isoWeekOf, weekRange, holdBucket } from "../../src/domain/time";

test("isoWeekOf/weekRange round-trip and cover the instant", () => {
  const ms = Date.parse("2026-07-08T12:00:00"); // machine-local (declared tz rule)
  const wk = isoWeekOf(ms);
  expect(wk).toMatch(/^\d{4}-W\d{2}$/);
  const { start, end } = weekRange(wk);
  expect(start).toBeLessThanOrEqual(ms);
  expect(end).toBeGreaterThan(ms);
  expect(end - start).toBe(7 * 86_400_000);
  expect(isoWeekOf(start)).toBe(wk);
});

test("holdBucket buckets by hold seconds", () => {
  expect(holdBucket(60)).toBe("intraday");
  expect(holdBucket(3 * 86_400)).toBe("2-5d");
  expect(holdBucket(30 * 86_400)).toBe("2w+");
  expect(holdBucket(null)).toBe("open");
});
```

Implement `src/domain/time.ts` (machine-local week boundaries; a Monday-start ISO week; buckets `intraday`/`2-5d`/`1-2w`/`2w+`/`open`). Run the test to green.

- [ ] **Step 3: Write the failing repo test (includes the load-bearing survival test)**

```ts
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../src/store/migrations";
import { getJournal, upsertJournal, getWeeklyEntry, upsertWeeklyEntry, tradesInRange } from "../../src/store/journal";

function db() { const d = new Database(":memory:"); runMigrations(d); return d; }

test("upsertJournal round-trips fields + tags; getJournal returns null when absent", () => {
  const d = db();
  expect(getJournal(d, "t1")).toBeNull();
  upsertJournal(d, { tradeId: "t1", thesis: "breakout", emotion: "calm", conviction: 4, rating: 3,
    notes: "took it", manualStop: 12.5, setup: "breakout", tags: ["a", "b"], updatedAt: 100 });
  const j = getJournal(d, "t1")!;
  expect(j.manualStop).toBe(12.5);
  expect(j.setup).toBe("breakout");
  expect(j.tags.sort()).toEqual(["a", "b"]);
});

test("upsertJournal replaces tags (not append) and is idempotent", () => {
  const d = db();
  upsertJournal(d, { tradeId: "t1", thesis: null, emotion: null, conviction: null, rating: null,
    notes: null, manualStop: null, setup: null, tags: ["x", "y"], updatedAt: 1 });
  upsertJournal(d, { tradeId: "t1", thesis: null, emotion: null, conviction: null, rating: null,
    notes: null, manualStop: null, setup: null, tags: ["y", "z"], updatedAt: 2 });
  expect(getJournal(d, "t1")!.tags.sort()).toEqual(["y", "z"]);
});

test("JOURNAL SURVIVES A FULL DERIVED REBUILD (load-bearing invariant)", () => {
  const d = db();
  d.run(`INSERT INTO trades (id, account, symbol, currency, direction, status, open_time, avg_entry, max_qty, fees, coverage_ok)
         VALUES ('t1','a','US.AAPL','USD','LONG','closed', 100, 10, 1, 0, 1)`);
  upsertJournal(d, { tradeId: "t1", thesis: "keep me", emotion: null, conviction: null, rating: null,
    notes: null, manualStop: 9, setup: "breakout", tags: ["keep"], updatedAt: 1 });
  // Simulate replaceDerived's wipe:
  d.run(`DELETE FROM flags`); d.run(`DELETE FROM trade_fills`); d.run(`DELETE FROM trades`);
  const j = getJournal(d, "t1");
  expect(j).not.toBeNull();
  expect(j!.thesis).toBe("keep me");
  expect(j!.tags).toEqual(["keep"]);
});

test("weekly entry round-trips with watchlist; tradesInRange filters by open OR close time", () => {
  const d = db();
  upsertWeeklyEntry(d, { id: "2026-W28", periodStart: 0, periodEnd: 1000, marketRead: "risk-on",
    tradedVsPlan: "ok", watchlist: [{ symbol: "US.NVDA", note: "watch", keyLevel: 120 }], updatedAt: 5 });
  const w = getWeeklyEntry(d, "2026-W28")!;
  expect(w.marketRead).toBe("risk-on");
  expect(w.watchlist[0]!.symbol).toBe("US.NVDA");
  d.run(`INSERT INTO trades (id, account, symbol, currency, direction, status, open_time, close_time, avg_entry, max_qty, fees, coverage_ok)
         VALUES ('t1','a','US.AAPL','USD','LONG','closed', 500, 900, 10, 1, 0, 1)`);
  expect(tradesInRange(d, 0, 1000).map((t) => t.id)).toEqual(["t1"]);
  expect(tradesInRange(d, 2000, 3000)).toHaveLength(0);
});
```

- [ ] **Step 4: Implement `src/store/journal.ts`**

Contract (all functions take `db: Database` first):
- `getJournal(db, tradeId): Journal | null` — join `journal` + `journal_tags`.
- `upsertJournal(db, j: Journal): void` — one transaction: upsert the row, `DELETE FROM journal_tags WHERE trade_id=?`, reinsert tags.
- `getWeeklyEntry(db, id): WeeklyEntry | null` — join `journal_entries` + `watchlist_items`.
- `upsertWeeklyEntry(db, w: WeeklyEntry): void` — one transaction, watchlist replaced like tags.
- `tradesInRange(db, startMs, endMs): Trade[]` — `SELECT * FROM trades WHERE (open_time >= ? AND open_time < ?) OR (close_time >= ? AND close_time < ?)`, mapped via the same row→Trade shape as `allTrades` (reuse a shared mapper if you extract one; otherwise inline, matching `repos.ts:153`).
- `manualStops(db): Map<string, number>` — `SELECT trade_id, manual_stop FROM journal WHERE manual_stop IS NOT NULL`. Used by `rebuildDerived` (Task 3).
- `distinctSetups(db): string[]`, `distinctTags(db): string[]` — `SELECT DISTINCT` for `/api/meta` (Task 6).

Run the test to green.

- [ ] **Step 5: Commit**

```bash
git add src/domain/journal-types.ts src/domain/time.ts src/store/journal.ts test/store/journal.test.ts test/domain/time.test.ts
git commit -m "feat(store): journal + weekly-entry repos; journal survives derived rebuild"
```

---

## Task 3: Split `runSync` into `pullRaw` + `rebuildDerived`; wire manual stops

**Files:**
- Modify: `src/sync/sync.ts`
- Modify: `src/sync/run.ts` (call sites)
- Test: `test/sync/rebuild.test.ts` (new), existing `test/sync/sync.test.ts` must stay green

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../src/store/migrations";
import { rebuildDerived } from "../../src/sync/sync";
import { upsertRawFills } from "../../src/store/repos";
import { upsertJournal } from "../../src/store/journal";
import { allTrades } from "../../src/store/repos";
import { DEFAULT_RULE_CONFIG } from "../../src/domain/types";

const noCandles = { getCandles: async () => [] };

function seedRoundTrip(db: Database) {
  upsertRawFills(db, [
    { id: "f1", orderId: "o1", symbol: "US.AAPL", side: "BUY", qty: 10, price: 100, fee: 0, currency: "USD", time: 1000, account: "a" },
    { id: "f2", orderId: "o2", symbol: "US.AAPL", side: "SELL", qty: 10, price: 110, fee: 0, currency: "USD", time: 2000, account: "a" },
  ]);
}

test("rebuildDerived rebuilds trades from raw with no OpenD involved", async () => {
  const db = new Database(":memory:"); runMigrations(db); seedRoundTrip(db);
  await rebuildDerived(db, { candles: noCandles, config: DEFAULT_RULE_CONFIG, now: 3000 });
  const trades = allTrades(db);
  expect(trades).toHaveLength(1);
  expect(trades[0]!.realizedPnl).toBe(100);
});

test("a manual stop overrides inference → risk/rMultiple recompute via rebuildDerived", async () => {
  const db = new Database(":memory:"); runMigrations(db); seedRoundTrip(db);
  await rebuildDerived(db, { candles: noCandles, config: DEFAULT_RULE_CONFIG, now: 3000 });
  const before = allTrades(db)[0]!;
  expect(before.risk).toBeNull(); // no protective order, no manual stop → no risk

  upsertJournal(db, { tradeId: before.id, thesis: null, emotion: null, conviction: null, rating: null,
    notes: null, manualStop: 95, setup: null, tags: [], updatedAt: 1 });
  await rebuildDerived(db, { candles: noCandles, config: DEFAULT_RULE_CONFIG, now: 3000 });
  const after = allTrades(db)[0]!;
  expect(after.risk).toBeCloseTo(50);      // |100 - 95| * 10
  expect(after.rMultiple).toBeCloseTo(2);  // realized 100 / risk 50
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/sync/rebuild.test.ts`
Expected: FAIL — `rebuildDerived` not exported.

- [ ] **Step 3: Refactor `src/sync/sync.ts`**

Split the existing `runSync` body:

- Extract the pull loop (`sync.ts:119–151`, everything writing raw + snapshots + sync_state) into
  `export async function pullRaw(db, client, opts: { now: number; historyDays?: number }): Promise<{ accounts: number }>`.
- Extract the rebuild body (`sync.ts:153–218`) into
  `export async function rebuildDerived(db, opts: { candles: CandleSource; config: RuleConfig; now: number }): Promise<void>`.
- Inside `rebuildDerived`, after `inferStops`, apply the manual-stop override **before** `computeRisk`:

```ts
import { manualStops } from "../store/journal";
// ...
const manual = manualStops(db); // Map<tradeId, number>
// ... per trade:
const inferred = inferStops(t, symbolOrders);
const ms = manual.get(t.id);
const initialStop = ms ?? inferred.initialStop; // manual overrides inferred for risk (decision 3)
const effectiveStop = ms ?? inferred.effectiveStop;
const { risk, rMultiple } = computeRisk(t, initialStop);
// use effectiveStop for the enriched trade + held_past_stop rule input
```

- Keep `runSync(deps)` as a thin wrapper for the CLI:

```ts
export async function runSync(deps: SyncDeps): Promise<SyncResult> {
  await pullRaw(deps.db, deps.client, { now: deps.now, historyDays: deps.historyDays });
  await rebuildDerived(deps.db, { candles: deps.candles, config: deps.config, now: deps.now });
  // recompute the summary counts from the DB (allRawFills/allRawOrders/allTrades + flag count)
  return { accounts: /* from pullRaw */, fills, orders, trades, flags };
}
```

Have `pullRaw` return `accounts` so `runSync` can assemble the same `SyncResult`. Read counts back with `allRawFills(db).length` etc. so the reported numbers stay DISTINCT-deduped (matching current behavior at `sync.ts:224`).

- [ ] **Step 4: Run all sync tests**

Run: `bun test test/sync/`
Expected: PASS — new `rebuild.test.ts` green **and** the existing `sync.test.ts` unchanged-green (the wrapper preserves behavior).

- [ ] **Step 5: Update `src/sync/run.ts`**

No behavior change — it still calls `runSync`. (The cache decorator is wired in Task 4.) Run `bunx tsc --noEmit`.

- [ ] **Step 6: Commit**

```bash
git add src/sync/sync.ts src/sync/run.ts test/sync/rebuild.test.ts
git commit -m "refactor(sync): split runSync into pullRaw + rebuildDerived; manual stop overrides inference"
```

---

## Task 4: Candle cache as a `CandleSource` decorator

**Files:**
- Create: `src/store/candles-cache.ts`
- Modify: `src/sync/run.ts` (wrap `yahooCandles`)
- Test: `test/store/candles-cache.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../src/store/migrations";
import { cachedCandles } from "../../src/store/candles-cache";
import type { Candle } from "../../src/domain/types";

function db() { const d = new Database(":memory:"); runMigrations(d); return d; }
const DAY = 86_400_000;
const bars = (times: number[]): Candle[] => times.map((t) => ({ time: t, open: 1, high: 2, low: 1, close: 1.5, volume: 10 }));

test("first call hits the source and caches; second identical call serves from cache (no source hit)", async () => {
  const d = db();
  let hits = 0;
  const src = { getCandles: async (_s: string, from: number, to: number) => { hits++; return bars([from, from + DAY]); } };
  const c = cachedCandles(d, src, { now: 100 * DAY }); // old range → fully cacheable, no tail refetch
  const from = 1 * DAY, to = 3 * DAY, res = DAY;
  const a = await c.getCandles("US.AAPL", from, to, res);
  const b = await c.getCandles("US.AAPL", from, to, res);
  expect(a.length).toBeGreaterThan(0);
  expect(b).toEqual(a);
  expect(hits).toBe(1); // second call served from cache
});

test("a range ending near now refetches the tail (partial last bar)", async () => {
  const d = db();
  let hits = 0;
  const now = 100 * DAY;
  const src = { getCandles: async (_s: string, from: number) => { hits++; return bars([from]); } };
  const c = cachedCandles(d, src, { now });
  await c.getCandles("US.AAPL", now - 3 * DAY, now, DAY);
  await c.getCandles("US.AAPL", now - 3 * DAY, now, DAY); // still near now → refetch tail
  expect(hits).toBe(2);
});

test("source failure with a warm cache still returns cached bars", async () => {
  const d = db();
  const now = 100 * DAY;
  const good = { getCandles: async (_s: string, from: number) => bars([from, from + DAY]) };
  const c1 = cachedCandles(d, good, { now });
  await c1.getCandles("US.AAPL", 1 * DAY, 3 * DAY, DAY);
  const bad = { getCandles: async () => { throw new Error("network down"); } };
  const c2 = cachedCandles(d, bad, { now });
  const out = await c2.getCandles("US.AAPL", 1 * DAY, 3 * DAY, DAY);
  expect(out.length).toBeGreaterThan(0); // served from cache despite source throwing
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/store/candles-cache.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `src/store/candles-cache.ts`**

```ts
import type { Database } from "bun:sqlite";
import type { CandleSource } from "../domain/ports";
import type { Candle } from "../domain/types";

const TAIL_MS = 2 * 86_400_000; // last ~2 days may be partial/backfilled → refetch

export interface CacheOpts { now: number }

function readBars(db: Database, symbol: string, resMs: number, from: number, to: number): Candle[] {
  return (db.query(
    `SELECT time, open, high, low, close, volume FROM candles_cache
     WHERE symbol=? AND res_ms=? AND time>=? AND time<=? ORDER BY time ASC`,
  ).all(symbol, resMs, from, to) as any[]).map((r) => ({ ...r }));
}

function writeBars(db: Database, symbol: string, resMs: number, candles: Candle[]): void {
  const stmt = db.prepare(
    `INSERT INTO candles_cache (symbol, res_ms, time, open, high, low, close, volume)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(symbol,res_ms,time) DO UPDATE SET
       open=excluded.open, high=excluded.high, low=excluded.low, close=excluded.close, volume=excluded.volume`,
  );
  db.transaction(() => { for (const c of candles) stmt.run(symbol, resMs, c.time, c.open, c.high, c.low, c.close, c.volume); })();
}

/** Wrap a CandleSource so bars fetched once are cached. Closed bars are immutable; only a range
 * whose end is within TAIL_MS of `now` refetches (the last bar is partial and Yahoo backfills). */
export function cachedCandles(db: Database, source: CandleSource, opts: CacheOpts): CandleSource {
  return {
    async getCandles(symbol, fromMs, toMs, resMs) {
      const coverage = db.query(
        `SELECT from_ms, to_ms FROM candle_coverage WHERE symbol=? AND res_ms=?`,
      ).get(symbol, resMs) as { from_ms: number; to_ms: number } | null;
      const covered = coverage !== null && coverage.from_ms <= fromMs && coverage.to_ms >= toMs;
      const nearNow = toMs >= opts.now - TAIL_MS;
      if (covered && !nearNow) return readBars(db, symbol, resMs, fromMs, toMs);
      let fresh: Candle[] = [];
      try {
        fresh = await source.getCandles(symbol, fromMs, toMs, resMs);
      } catch {
        return readBars(db, symbol, resMs, fromMs, toMs); // degrade to cache on source failure
      }
      if (fresh.length) {
        writeBars(db, symbol, resMs, fresh);
        const newFrom = coverage ? Math.min(coverage.from_ms, fromMs) : fromMs;
        const newTo = coverage ? Math.max(coverage.to_ms, toMs) : toMs;
        db.run(
          `INSERT INTO candle_coverage (symbol,res_ms,from_ms,to_ms,fetched_at) VALUES (?,?,?,?,?)
           ON CONFLICT(symbol,res_ms) DO UPDATE SET from_ms=excluded.from_ms, to_ms=excluded.to_ms, fetched_at=excluded.fetched_at`,
          [symbol, resMs, newFrom, newTo, opts.now],
        );
      }
      return readBars(db, symbol, resMs, fromMs, toMs);
    },
  };
}
```

- [ ] **Step 4: Run to green, then wire into `run.ts`**

Run: `bun test test/store/candles-cache.test.ts` → PASS.
In `src/sync/run.ts`, wrap the source: `const candles = cachedCandles(db, yahooCandles, { now: Date.now() });` and pass `candles` to `runSync`. Run `bunx tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
git add src/store/candles-cache.ts src/sync/run.ts test/store/candles-cache.test.ts
git commit -m "feat(store): candle cache as a CandleSource decorator (warm charts, offline-capable)"
```

---

## Task 5: Read-model views — positions + meta

**Files:**
- Create: `src/api/views.ts`
- Test: `test/api/views.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../src/store/migrations";
import { openPositions, metaView, tradeDetail } from "../../src/api/views";
import { insertPositionSnapshot } from "../../src/store/repos";

function db() { const d = new Database(":memory:"); runMigrations(d); return d; }

test("openPositions joins snapshot + open trade and computes open risk per currency", () => {
  const d = db();
  // open trade with an effective stop
  d.run(`INSERT INTO trades (id, account, symbol, currency, direction, status, open_time, avg_entry, max_qty, fees, coverage_ok, effective_stop)
         VALUES ('t1','a','US.AAPL','USD','LONG','open', 1000, 100, 10, 0, 1, 95)`);
  insertPositionSnapshot(d, [{ account: "a", symbol: "US.AAPL", qty: 10, avgCost: 100, currency: "USD", time: 5000 }]);
  const pos = openPositions(d, 5000);
  expect(pos).toHaveLength(1);
  expect(pos[0]!.currency).toBe("USD");
  expect(pos[0]!.openRisk).toBeCloseTo(50); // (100-95)*10
});

test("metaView surfaces currencies, setups, tags, accounts, coverage window", () => {
  const d = db();
  d.run(`INSERT INTO trades (id, account, symbol, currency, direction, status, open_time, avg_entry, max_qty, fees, coverage_ok)
         VALUES ('t1','a','US.AAPL','USD','LONG','closed', 1000, 100, 10, 0, 1)`);
  d.run(`INSERT INTO journal (trade_id, setup, updated_at) VALUES ('t1','breakout',1)`);
  d.run(`INSERT INTO journal_tags (trade_id, tag) VALUES ('t1','earnings')`);
  const m = metaView(d);
  expect(m.currencies).toContain("USD");
  expect(m.setups).toContain("breakout");
  expect(m.tags).toContain("earnings");
  expect(m.accounts).toContain("a");
});
```

- [ ] **Step 2 → 4: Implement `src/api/views.ts` to green**

- `openPositions(db, snapshotTime): Array<{ account, symbol, currency, qty, avgCost, effectiveStop, openRisk }>` — join `positionsAt(db, snapshotTime)` with open trades on `(account, symbol)`; `openRisk = effectiveStop == null ? null : |avgCost − effectiveStop| × |qty|`. **Never sum across currencies** — each row keeps its own currency; the API groups by currency (Plan 7 renders per-currency sections).
- `tradeDetail(db, id)` — `{ trade, fills, orders, flags, stop: StopInfo, journal }` using `allTrades`/`allRawFills`/`allRawOrders`/`inferStops`/`flagsForTrade`/`getJournal`. (Manual-stop override already lives in the stored trade from Task 3; expose the inferred `StopInfo` too so the UI can show provenance.)
- `metaView(db)` — `{ accounts, currencies, setups, tags, coverageStart, appVersion }` via `SELECT DISTINCT` + `getSyncState`/min coverage. `appVersion` from `package.json` version (import with `{ type: "json" }` or a constant).

- [ ] **Step 5: Commit**

```bash
git add src/api/views.ts test/api/views.test.ts
git commit -m "feat(api): read-model views — open positions (per-currency risk) + meta + trade detail"
```

---

## Task 6: HTTP API — read endpoints

**Files:**
- Create: `src/api/routes.ts`
- Test: `test/api/routes.test.ts`

**Endpoint contract (read):**
- `GET /api/stats` → `computeStats(allTrades(db))` (already `{ byCurrency }`).
- `GET /api/breakdowns?by=setup|tag|symbol|holdBucket` → `breakdown(allTrades(db), keyFn)` where the keyFn joins journal setup/tags or buckets hold-time. Returns `Breakdown[]` (per-currency).
- `GET /api/trades` → **all** trades, each `{ ...trade, flags, setup, tags }` embedded (no server-side filter/sort/pagination — Plan 7 filters client-side).
- `GET /api/trades/:id` → `tradeDetail(db, id)`; 404 if unknown.
- `GET /api/trades/:id/candles?res=day|hour` → candles via the injected `CandleSource` for the trade's padded window; `[]` (200) if none.
- `GET /api/positions` → `openPositions(db, latestSnapshotTime)` grouped `{ byCurrency: [{ currency, positions[] }] }`.
- `GET /api/meta` → `metaView(db)`.

- [ ] **Step 1: Write the failing test (handler called directly — no server/port)**

```ts
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../src/store/migrations";
import { buildApi } from "../../src/api/routes";
import { upsertRawFills } from "../../src/store/repos";
import { rebuildDerived } from "../../src/sync/sync";
import { DEFAULT_RULE_CONFIG } from "../../src/domain/types";

const noCandles = { getCandles: async () => [] };

async function api() {
  const db = new Database(":memory:"); runMigrations(db);
  upsertRawFills(db, [
    { id: "f1", orderId: "o1", symbol: "US.AAPL", side: "BUY", qty: 10, price: 100, fee: 0, currency: "USD", time: 1000, account: "a" },
    { id: "f2", orderId: "o2", symbol: "US.AAPL", side: "SELL", qty: 10, price: 110, fee: 0, currency: "USD", time: 2000, account: "a" },
  ]);
  await rebuildDerived(db, { candles: noCandles, config: DEFAULT_RULE_CONFIG, now: 3000 });
  return buildApi(db, { candles: noCandles, config: DEFAULT_RULE_CONFIG, sync: null as any, now: () => 3000 });
}

test("GET /api/stats returns currency-segmented stats", async () => {
  const app = await api();
  const res = await app(new Request("http://x/api/stats"));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.byCurrency[0].currency).toBe("USD");
  expect(body.byCurrency[0].netPnl).toBe(100);
});

test("GET /api/trades embeds flags + journal fields; unknown detail 404s", async () => {
  const app = await api();
  const list = await (await app(new Request("http://x/api/trades"))).json();
  expect(list).toHaveLength(1);
  expect(list[0]).toHaveProperty("flags");
  const missing = await app(new Request("http://x/api/trades/nope"));
  expect(missing.status).toBe(404);
});

test("unknown /api path 404s as JSON", async () => {
  const app = await api();
  const res = await app(new Request("http://x/api/nonsense"));
  expect(res.status).toBe(404);
  expect(res.headers.get("content-type")).toContain("application/json");
});
```

- [ ] **Step 2 → 4: Implement `src/api/routes.ts` to green**

`buildApi(db, deps): (req: Request) => Promise<Response>`. Use `Bun.serve`'s router shape indirectly by matching `new URL(req.url).pathname` + method in a small switch, or use `Bun.serve({ routes })` in Task 9 and keep `buildApi` returning a plain fetch handler for testability. JSON helper: `json(data, status=200)`. All handlers wrap in try/catch → `500 { error }`. Deps: `{ candles: CandleSource; config: RuleConfig; sync: SyncRunner; now: () => number }`.

- [ ] **Step 5: Commit**

```bash
git add src/api/routes.ts test/api/routes.test.ts
git commit -m "feat(api): read endpoints (stats, breakdowns, trades, detail, candles, positions, meta)"
```

---

## Task 7: Journal write endpoints → trigger `rebuildDerived`

**Files:**
- Modify: `src/api/routes.ts`
- Test: extend `test/api/routes.test.ts`

**Contract:**
- `PUT /api/trades/:id/journal` — body = journal document (thesis/emotion/conviction/rating/notes/manualStop/setup/tags). Validates conviction/rating ∈ 1..5 (or null). `upsertJournal`, then if `manualStop` changed **or** setup/tags changed (they feed breakdowns), call `rebuildDerived(db, { candles, config, now })`. Returns the updated `tradeDetail`.
- `GET /api/journal/weeks/:isoWeek` — `getWeeklyEntry` (or a 200 empty skeleton with computed `weekRange`) + `tradesInRange` for that week.
- `PUT /api/journal/weeks/:isoWeek` — `upsertWeeklyEntry` (compute period from `weekRange(isoWeek)`); returns the same shape as GET. Weekly writes do **not** rebuild derived data (no trade linkage).

- [ ] **Step 1: Write the failing test**

```ts
test("PUT journal with a manual stop recomputes R via rebuild", async () => {
  const app = await api();
  const id = (await (await app(new Request("http://x/api/trades"))).json())[0].id;
  const put = await app(new Request(`http://x/api/trades/${id}/journal`, {
    method: "PUT",
    body: JSON.stringify({ thesis: "t", emotion: null, conviction: 4, rating: null, notes: null, manualStop: 95, setup: "breakout", tags: ["a"] }),
  }));
  expect(put.status).toBe(200);
  const detail = await put.json();
  expect(detail.trade.risk).toBeCloseTo(50);
  expect(detail.trade.rMultiple).toBeCloseTo(2);
  expect(detail.journal.setup).toBe("breakout");
});

test("PUT journal rejects out-of-range conviction", async () => {
  const app = await api();
  const id = (await (await app(new Request("http://x/api/trades"))).json())[0].id;
  const res = await app(new Request(`http://x/api/trades/${id}/journal`, {
    method: "PUT", body: JSON.stringify({ conviction: 9, tags: [] }),
  }));
  expect(res.status).toBe(400);
});

test("weekly entry GET/PUT round-trips and lists that week's trades", async () => {
  const app = await api();
  await app(new Request("http://x/api/journal/weeks/2026-W28", {
    method: "PUT", body: JSON.stringify({ marketRead: "risk-on", tradedVsPlan: "ok", watchlist: [] }),
  }));
  const got = await (await app(new Request("http://x/api/journal/weeks/2026-W28"))).json();
  expect(got.marketRead).toBe("risk-on");
  expect(Array.isArray(got.trades)).toBe(true);
});
```

- [ ] **Step 2 → 4: Implement to green.** Reuse `now()` from deps for `updatedAt`.

- [ ] **Step 5: Commit**

```bash
git add src/api/routes.ts test/api/routes.test.ts
git commit -m "feat(api): journal + weekly-entry write endpoints; manual-stop edit re-derives"
```

---

## Task 8: Sync endpoints — in-process mutex + polled status

**Files:**
- Create: `src/api/sync-runner.ts`
- Modify: `src/api/routes.ts`
- Test: `test/api/sync-runner.test.ts`, extend `test/api/routes.test.ts`

**Contract:**
- `POST /api/sync` → if a sync is running, `409 { running: true }`; else start async (`pullRaw` with a freshly-connected OpenD client, then `rebuildDerived`), return `202`. The OpenD connection is opened **inside** the task and closed in `finally` — never a persistent connection.
- `GET /api/sync/status` → `{ running, startedAt, finishedAt, lastResult, lastError }`. Persist `lastResult`/`lastError` in the `config` KV so status survives a restart.

- [ ] **Step 1: Write the failing test for the runner**

```ts
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../src/store/migrations";
import { SyncRunner } from "../../src/api/sync-runner";

function db() { const d = new Database(":memory:"); runMigrations(d); return d; }

test("SyncRunner runs one job, exposes status, and refuses concurrent starts", async () => {
  const d = db();
  let running = 0, maxConcurrent = 0;
  const job = async () => {
    running++; maxConcurrent = Math.max(maxConcurrent, running);
    await new Promise((r) => setTimeout(r, 20));
    running--; return { accounts: 1, fills: 0, orders: 0, trades: 0, flags: 0 };
  };
  const runner = new SyncRunner(d, job, () => 111);
  const started1 = runner.start();
  const started2 = runner.start(); // while first in flight
  expect(started1).toBe(true);
  expect(started2).toBe(false);   // mutex refuses the second
  expect(runner.status().running).toBe(true);
  await runner.whenIdle();
  expect(maxConcurrent).toBe(1);
  const s = runner.status();
  expect(s.running).toBe(false);
  expect(s.lastResult?.accounts).toBe(1);
});

test("a job that throws records lastError and clears running", async () => {
  const d = db();
  const runner = new SyncRunner(d, async () => { throw new Error("OpenD down"); }, () => 1);
  runner.start();
  await runner.whenIdle();
  expect(runner.status().running).toBe(false);
  expect(runner.status().lastError).toContain("OpenD down");
});
```

- [ ] **Step 2 → 4: Implement `SyncRunner` to green.** Module-level/instance boolean mutex; `start(): boolean`; `status()`; `whenIdle(): Promise<void>` (test hook). Persist `lastResult`/`lastError`/`finishedAt` to `config` under key `sync_status`. Wire `POST /api/sync` + `GET /api/sync/status` into `routes.ts` (the route test uses a fake job so no real OpenD).

- [ ] **Step 5: Commit**

```bash
git add src/api/sync-runner.ts src/api/routes.ts test/api/sync-runner.test.ts test/api/routes.test.ts
git commit -m "feat(api): sync-now endpoint with in-process mutex + polled status (read-only-safe)"
```

---

## Task 9: Static serving + app bootstrap + compile proof

**Files:**
- Create: `src/api/static.ts`
- Create: `web/index.html` (placeholder)
- Create: `src/app.ts`
- Test: `test/api/static.test.ts`

- [ ] **Step 1: Write `web/index.html` placeholder**

```html
<!doctype html>
<html><head><meta charset="utf-8"><title>Trade Review</title></head>
<body><div id="root">Trade Review API is running. UI ships in Plan 7.</div></body></html>
```

- [ ] **Step 2: Write the failing test for static + fallback**

```ts
import { test, expect } from "bun:test";
import { serveStatic } from "../../src/api/static";

test("serves index.html at / and falls back to it for unknown non-/api paths (SPA history)", async () => {
  const root = await (await serveStatic(new Request("http://x/"))).text();
  expect(root).toContain("Trade Review");
  const deep = await serveStatic(new Request("http://x/trades/123")); // client route
  expect(deep.status).toBe(200);
  expect(await deep.text()).toContain("Trade Review");
});

test("returns null for /api paths so the API handler takes them", async () => {
  expect(await serveStatic(new Request("http://x/api/stats"))).toBeNull();
});
```

- [ ] **Step 3: Implement `src/api/static.ts`**

Serve `web/index.html` (and later Plan 7's built assets) via `Bun.file`. `serveStatic(req): Promise<Response | null>` — return `null` for `/api/*` (let the API own it); serve matching asset files; fall back to `index.html` for any other GET (SPA history routing). Import the placeholder for embedding: `import indexHtml from "../web/index.html" with { type: "file" }` and serve `Bun.file(indexHtml)` (this is the pattern that survives `bun build --compile`).

- [ ] **Step 4: Implement `src/app.ts` (bootstrap)**

```ts
// backup-on-startup (keep last N) → migrate → serve API + static on 127.0.0.1 → open browser.
import { openDb } from "./store/db";
import { runMigrations } from "./store/migrations";
import { backupDb } from "./store/backup";
import { dbPath } from "./store/paths";
import { getRuleConfig } from "./store/config";
import { buildApi } from "./api/routes";
import { serveStatic } from "./api/static";
import { cachedCandles } from "./store/candles-cache";
import { yahooCandles } from "./candles/yahoo";
import { SyncRunner } from "./api/sync-runner";
import { pullRaw, rebuildDerived } from "./sync/sync";
import { connectFutu } from "./futu/client";

export function main() {
  const path = dbPath();
  backupDb(path, stamp()); // reuse run.ts's stamp()
  const db = openDb(path);
  runMigrations(db);
  const config = getRuleConfig(db);
  const candles = cachedCandles(db, yahooCandles, { now: Date.now() });
  const syncJob = async () => {
    const key = process.env.OPEND_WS_KEY || undefined;
    const client = await connectFutu({ key });
    try {
      const now = Date.now();
      await pullRaw(db, client, { now });
      await rebuildDerived(db, { candles, config, now });
      return /* SyncResult from DB counts */;
    } finally { client.close(); }
  };
  const sync = new SyncRunner(db, syncJob, Date.now);
  const api = buildApi(db, { candles, config, sync, now: Date.now });

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: Number(process.env.PORT ?? 8123),
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.startsWith("/api/")) return api(req);
      return (await serveStatic(req)) ?? new Response("Not found", { status: 404 });
    },
  });
  const openUrl = `http://127.0.0.1:${server.port}`;
  console.log(`Trade Review on ${openUrl}`);
  openBrowser(openUrl); // `open`/`start`/`xdg-open` by platform; best-effort
}

if (import.meta.main) main();
```

- [ ] **Step 5: Run tests + prove the compile embeds the shell**

```bash
bun test && bunx tsc --noEmit
bun build src/app.ts --compile --outfile /tmp/trade-review-test
PORT=8199 /tmp/trade-review-test &          # starts the server from the binary
sleep 1
curl -s localhost:8199/ | grep -q "Trade Review" && echo "STATIC OK"
curl -s localhost:8199/api/meta | grep -q "currencies" && echo "API OK"
kill %1
```

Expected: `STATIC OK` **and** `API OK` — the single compiled binary serves both the embedded shell and the live API. (This de-risks the `--compile` asset-embedding unknown before Plan 7 builds the real SPA.)

- [ ] **Step 6: Commit**

```bash
git add src/api/static.ts src/app.ts web/index.html test/api/static.test.ts
git commit -m "feat(app): single-binary bootstrap — backup, migrate, serve API + SPA shell on 127.0.0.1"
```

---

## Gates before the PR (project working agreement)

1. `bun test` — all green (existing 147 + new).
2. `bunx tsc --noEmit` — clean.
3. `codex exec review --base main` — clean (no must-fix).
4. Fable adversarial review — clean.

Then self-merge: `gh pr merge <n> --merge --delete-branch` and sync local `main`.

## Self-review checklist (author)

- **Spec coverage:** journal model §10 ✅ (per-trade + weekly), analytics wire-up §7 ✅, positions §11 ✅, sync-now §12 ✅, single-binary §14 ✅. Charts §8 data endpoint ✅ (rendering is Plan 7).
- **Money math:** every aggregate ships under `byCurrency`; positions grouped per currency; manual stop re-derives through `computeRisk`. No cross-currency sum anywhere. ✅
- **Rebuild safety:** journal tables have no FK to `trades`; explicit survival test (Task 2). ✅
- **Type consistency:** `Journal`/`WeeklyEntry`/`WatchlistItem` defined in Task 2, consumed identically in Tasks 5–7. `rebuildDerived`/`pullRaw` signatures fixed in Task 3, reused in Tasks 6–9. ✅
