# FUTU Trade Review — Plan 1: Foundation & FUTU Spike Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the project, prove FUTU data flows through a compiled Bun binary, and build the persistence layer plus the round-trip `trade-builder` core — all tested.

**Architecture:** A Bun + TypeScript project. Pure domain logic (`trade-builder`) lives in `src/core/` and is unit-tested with zero external dependencies. Persistence (`src/store/`) wraps `bun:sqlite` with a versioned migration runner and pre-migration backup. A throwaway spike (`src/futu/spike.ts`) de-risks the one thing that could force a stack change: whether the official `futu-api` npm package connects to OpenD and survives `bun build --compile`.

**Tech Stack:** Bun (runtime + test runner + bundler), TypeScript, `bun:sqlite`, `futu-api` (npm, for the spike only in this plan).

**Reference spec:** `docs/superpowers/specs/2026-07-10-futu-trade-review-design.md` (§4 modules, §5 data model, §6 trade building, §15 build order).

---

## File Structure (Plan 1 scope)

```
Trade-Review/
├── package.json                         # scripts + deps
├── tsconfig.json                        # strict TS config
├── src/
│   ├── domain/
│   │   └── types.ts                     # RawFill, SeedPosition, Trade, enums (shared vocabulary)
│   ├── core/
│   │   └── trade-builder.ts             # buildTrades(fills, seeds) → Trade[]  (PURE)
│   ├── store/
│   │   ├── paths.ts                     # user-data dir + db path resolution
│   │   ├── db.ts                        # open bun:sqlite database
│   │   ├── migrations.ts               # versioned migration runner + migration list
│   │   └── backup.ts                    # pre-migration file backup
│   └── futu/
│       └── spike.ts                     # throwaway connectivity + compile proof
└── test/
    ├── helpers.ts                       # fill() builder for concise fixtures
    ├── core/
    │   └── trade-builder.test.ts
    └── store/
        └── migrations.test.ts
```

**Responsibilities:** `domain/types.ts` is the shared vocabulary every later module imports. `core/trade-builder.ts` is pure and holds the correctness-critical aggregation. `store/*` is the only place that touches disk/SQLite. `futu/spike.ts` is deleted after Plan 1 (its lessons feed the real `futu-client` in Plan 4).

---

## Task 0: Project scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `test/smoke.test.ts` (deleted at end of task)

- [ ] **Step 1: Initialize the Bun project**

Run:
```bash
cd /Users/keith/Dev/Trade-Review
bun init -y
bun add -d typescript @types/bun
```
Expected: `package.json`, `tsconfig.json`, `node_modules/` created. (`.gitignore` already ignores `node_modules/` and `dist/`.)

- [ ] **Step 2: Overwrite `package.json` scripts**

Replace the `scripts` block in `package.json` with:
```json
{
  "name": "trade-review",
  "module": "src/app.ts",
  "type": "module",
  "private": true,
  "scripts": {
    "test": "bun test",
    "typecheck": "bunx tsc --noEmit"
  }
}
```
(Keep the `devDependencies` block that `bun init`/`bun add` created.)

- [ ] **Step 3: Overwrite `tsconfig.json` with strict settings**

```json
{
  "compilerOptions": {
    "lib": ["ESNext"],
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "types": ["bun-types"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src", "test"]
}
```

- [ ] **Step 4: Add a smoke test to prove the runner works**

Create `test/smoke.test.ts`:
```ts
import { test, expect } from "bun:test";

test("bun test runs", () => {
  expect(1 + 1).toBe(2);
});
```

- [ ] **Step 5: Run the smoke test**

Run: `bun test`
Expected: `1 pass, 0 fail`.

- [ ] **Step 6: Delete the smoke test and commit**

```bash
rm test/smoke.test.ts
git add -A
git commit -m "chore: scaffold Bun + TypeScript project"
```

---

## Task 1: Domain types (shared vocabulary)

**Files:**
- Create: `src/domain/types.ts`

Every later task/plan imports these. Defining them once here prevents drift.

- [ ] **Step 1: Write the types**

Create `src/domain/types.ts`:
```ts
export type Side = "BUY" | "SELL";
export type Direction = "LONG" | "SHORT";
export type TradeStatus = "open" | "closed";

/** One execution as returned by FUTU (a "deal"/fill). qty is always positive. */
export interface RawFill {
  id: string;
  orderId: string;
  symbol: string;
  side: Side;
  qty: number;
  price: number;
  fee: number;
  currency: string;
  time: number; // epoch milliseconds
  account: string;
}

/** A position already open before our fill history begins (from a positions snapshot). */
export interface SeedPosition {
  account: string;
  symbol: string;
  qty: number; // signed: positive = long, negative = short
}

/** A reconstructed round-trip trade. */
export interface Trade {
  id: string; // deterministic: `${account}:${symbol}:${openTime}`
  account: string;
  symbol: string;
  currency: string;
  direction: Direction;
  status: TradeStatus;
  openTime: number;
  closeTime: number | null;
  avgEntry: number;
  avgExit: number | null;
  maxQty: number;
  realizedPnl: number | null;
  fees: number;
  holdSeconds: number | null;
  coverageOk: boolean; // false when the trade began before our data coverage (seeded)
  fillIds: string[];
}
```

- [ ] **Step 2: Typecheck**

Run: `bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/domain/types.ts
git commit -m "feat: add domain types (RawFill, SeedPosition, Trade)"
```

---

## Task 2: FUTU connectivity spike (de-risk the stack — do this before building features)

**Files:**
- Create: `src/futu/spike.ts`

**Purpose:** Prove two things, in order: (a) `futu-api` can connect to a running OpenD and pull real account + historical fill data, and (b) that still works after `bun build --compile`. If either fails, STOP and escalate — the fallback is a Node runtime or a small Python sidecar (spec §15). This task is a spike, not TDD; its output is a go/no-go decision, and the file is deleted in Task-final of Plan 4.

**Prerequisite (human):** OpenD is installed, running, and logged in (moomoo/FUTU account, API questionnaire completed). Note the WebSocket port (default `33333`).

- [ ] **Step 1: Install the SDK**

Run: `bun add futu-api`
Expected: `futu-api` added to `dependencies`.

- [ ] **Step 2: Write the spike script**

Create `src/futu/spike.ts`. The exact method names come from the `futu-api` package README (`node_modules/futu-api/README.md`) — the SDK is protobuf-based and thinly documented, so **read that README first** and adapt the calls below. The goal is only to print real data.

```ts
// Throwaway spike. Deleted once the real futu-client (Plan 4) exists.
// Proves: futu-api connects to OpenD and returns account + historical fill data.
import { ftWebsocket } from "futu-api";

const HOST = "127.0.0.1";
const PORT = Number(process.env.OPEND_PORT ?? 33333);

async function main() {
  const ws = new ftWebsocket();
  await new Promise<void>((resolve, reject) => {
    ws.onlogin = (ok: boolean) => (ok ? resolve() : reject(new Error("OpenD login failed")));
    ws.start(HOST, PORT, false); // false = no SSL for localhost
  });
  console.log("Connected to OpenD.");

  // 1) List trading accounts. (Method: consult README — e.g. GetAccList / Trd_GetAccList.)
  // 2) For the first account, pull historical fills/deals over the last ~90 days.
  //    (Method: consult README — e.g. Trd_GetHistoryOrderFillList.)
  // Print the raw shape so we learn the field names for the real futu-client.
  // Replace the two calls below with the SDK's actual method signatures.

  console.log("TODO: call account-list method, print result");
  console.log("TODO: call historical-fills method, print first 5 results");

  ws.stop();
}

main().catch((e) => {
  console.error("SPIKE FAILED:", e);
  process.exit(1);
});
```

- [ ] **Step 3: Run the spike under the Bun runtime**

Run: `OPEND_PORT=33333 bun run src/futu/spike.ts`
Expected: `Connected to OpenD.` followed by printed account + fill data.
**If it fails to connect:** verify OpenD is running/logged in and the port matches. **If `futu-api` itself throws under Bun** (missing Node API, protobuf load error): record the exact error and escalate — this is the go/no-go signal.

- [ ] **Step 4: Fill in the real SDK calls**

Using `node_modules/futu-api/README.md`, replace the two `TODO` log lines with the actual account-list and historical-fills calls. Re-run Step 3 until real fills print.

- [ ] **Step 5: Prove it survives `bun build --compile` (the critical check)**

Run:
```bash
bun build src/futu/spike.ts --compile --outfile /tmp/spike-bin
OPEND_PORT=33333 /tmp/spike-bin
```
Expected: the compiled binary prints the same `Connected to OpenD.` + fill data.
**If the compiled binary behaves differently from `bun run`** (e.g. native dep not bundled), record the error and escalate — this is exactly the risk the spike exists to catch.

- [ ] **Step 6: Record the verdict and commit**

Append a short `## Spike Result` note to the spec file (`docs/superpowers/specs/2026-07-10-futu-trade-review-design.md`): PASS/FAIL, the real method names discovered, and the exact `RawFill`/order field names FUTU returns (these feed Plan 4's `futu-client`).

```bash
rm -f /tmp/spike-bin
git add -A
git commit -m "spike: prove futu-api connects to OpenD and compiles under Bun"
```

> **GATE:** Do not proceed to Task 3+ feature work until Steps 5–6 PASS or a fallback stack decision is recorded.

---

## Task 3: Persistence layer (store + migrations + backup)

**Files:**
- Create: `src/store/paths.ts`
- Create: `src/store/db.ts`
- Create: `src/store/backup.ts`
- Create: `src/store/migrations.ts`
- Test: `test/store/migrations.test.ts`

The migration runner tracks a version in `schema_version`, applies only newer migrations, is idempotent, and backs up the DB file before applying anything.

- [ ] **Step 1: Write path resolution**

Create `src/store/paths.ts`:
```ts
import { homedir } from "node:os";
import { join } from "node:path";

/** Stable per-user data directory. DB lives here, never next to the binary. */
export function dataDir(): string {
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "TradeReview");
  }
  if (process.platform === "win32") {
    return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "TradeReview");
  }
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "TradeReview");
}

export function dbPath(dir: string = dataDir()): string {
  return join(dir, "trade-review.sqlite");
}
```

- [ ] **Step 2: Write the DB opener**

Create `src/store/db.ts`:
```ts
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function openDb(path: string): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL;");
  db.run("PRAGMA foreign_keys = ON;");
  return db;
}
```

- [ ] **Step 3: Write the backup helper**

Create `src/store/backup.ts`:
```ts
import { copyFileSync, existsSync } from "node:fs";

/** Copy the DB file to a timestamped backup. `stamp` is passed in (no Date.now in pure paths). */
export function backupDb(path: string, stamp: string): string | null {
  if (!existsSync(path)) return null; // nothing to back up on first run
  const dest = `${path}.backup-${stamp}`;
  copyFileSync(path, dest);
  return dest;
}
```

- [ ] **Step 4: Write the failing migrations test**

Create `test/store/migrations.test.ts`:
```ts
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
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `bun test test/store/migrations.test.ts`
Expected: FAIL — cannot find module `../../src/store/migrations`.

- [ ] **Step 6: Write the migration runner**

Create `src/store/migrations.ts`:
```ts
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
  for (let i = from; i < MIGRATIONS.length; i++) {
    const migrate = MIGRATIONS[i]!;
    db.transaction(() => {
      migrate(db);
      setVersion(db, i + 1);
    })();
  }
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `bun test test/store/migrations.test.ts`
Expected: `3 pass, 0 fail`.

- [ ] **Step 8: Typecheck and commit**

```bash
bunx tsc --noEmit
git add src/store test/store
git commit -m "feat: sqlite store with versioned migrations and backup"
```

---

## Task 4: `trade-builder` — round-trip aggregation (the core, pure, TDD)

**Files:**
- Create: `test/helpers.ts`
- Create: `test/core/trade-builder.test.ts`
- Create: `src/core/trade-builder.ts`

Turns a flat list of `RawFill`s into round-trip `Trade`s. Pure — no I/O. Covers scale-in, scale-out, flip-through-zero, still-open, and seeded pre-existing positions (spec §6).

- [ ] **Step 1: Write the test helper**

Create `test/helpers.ts`:
```ts
import type { RawFill, Side } from "../src/domain/types";

let seq = 0;
/** Concise fill builder. time defaults to a monotonically increasing minute. */
export function fill(side: Side, qty: number, price: number, over: Partial<RawFill> = {}): RawFill {
  seq += 1;
  return {
    id: over.id ?? `f${seq}`,
    orderId: over.orderId ?? `o${seq}`,
    symbol: over.symbol ?? "AAPL",
    side,
    qty,
    price,
    fee: over.fee ?? 0,
    currency: over.currency ?? "USD",
    time: over.time ?? seq * 60_000,
    account: over.account ?? "acc1",
  };
}
```

- [ ] **Step 2: Write the failing test suite**

Create `test/core/trade-builder.test.ts`:
```ts
import { test, expect } from "bun:test";
import { buildTrades } from "../../src/core/trade-builder";
import { fill } from "../helpers";
import type { SeedPosition } from "../../src/domain/types";

test("simple long round-trip", () => {
  const trades = buildTrades([fill("BUY", 100, 10), fill("SELL", 100, 12)]);
  expect(trades).toHaveLength(1);
  const t = trades[0]!;
  expect(t.direction).toBe("LONG");
  expect(t.status).toBe("closed");
  expect(t.avgEntry).toBe(10);
  expect(t.avgExit).toBe(12);
  expect(t.maxQty).toBe(100);
  expect(t.realizedPnl).toBe(200);
  expect(t.coverageOk).toBe(true);
});

test("simple short round-trip", () => {
  const trades = buildTrades([fill("SELL", 100, 12), fill("BUY", 100, 10)]);
  expect(trades).toHaveLength(1);
  const t = trades[0]!;
  expect(t.direction).toBe("SHORT");
  expect(t.realizedPnl).toBe(200); // sold 1200, bought back 1000
});

test("fees reduce realized pnl", () => {
  const trades = buildTrades([
    fill("BUY", 100, 10, { fee: 1 }),
    fill("SELL", 100, 12, { fee: 1 }),
  ]);
  expect(trades[0]!.realizedPnl).toBe(198);
  expect(trades[0]!.fees).toBe(2);
});

test("scale-in averages entry", () => {
  const trades = buildTrades([
    fill("BUY", 100, 10),
    fill("BUY", 100, 12),
    fill("SELL", 200, 15),
  ]);
  expect(trades).toHaveLength(1);
  expect(trades[0]!.avgEntry).toBe(11);
  expect(trades[0]!.maxQty).toBe(200);
  expect(trades[0]!.realizedPnl).toBe(800); // 3000 - 2200
});

test("partial scale-out then close", () => {
  const trades = buildTrades([
    fill("BUY", 100, 10),
    fill("SELL", 50, 12),
    fill("SELL", 50, 14),
  ]);
  expect(trades).toHaveLength(1);
  expect(trades[0]!.avgExit).toBe(13);
  expect(trades[0]!.realizedPnl).toBe(300); // 1300 - 1000
});

test("flip through zero splits into two trades", () => {
  const trades = buildTrades([fill("BUY", 100, 10), fill("SELL", 150, 12)]);
  expect(trades).toHaveLength(2);
  const [long, short] = trades;
  expect(long!.direction).toBe("LONG");
  expect(long!.status).toBe("closed");
  expect(long!.realizedPnl).toBe(200); // 100 @10 -> 100 @12
  expect(short!.direction).toBe("SHORT");
  expect(short!.status).toBe("open");
  expect(short!.avgEntry).toBe(12);
  expect(short!.maxQty).toBe(50);
});

test("still-open trade has null exit/pnl", () => {
  const trades = buildTrades([fill("BUY", 100, 10)]);
  expect(trades).toHaveLength(1);
  const t = trades[0]!;
  expect(t.status).toBe("open");
  expect(t.avgExit).toBeNull();
  expect(t.realizedPnl).toBeNull();
  expect(t.closeTime).toBeNull();
});

test("seeded pre-existing position is flagged coverage_ok=false", () => {
  const seeds: SeedPosition[] = [{ account: "acc1", symbol: "AAPL", qty: 100 }];
  const trades = buildTrades([fill("SELL", 100, 12)], seeds);
  expect(trades).toHaveLength(1);
  expect(trades[0]!.status).toBe("closed");
  expect(trades[0]!.coverageOk).toBe(false);
});

test("separate symbols and accounts do not mix", () => {
  const trades = buildTrades([
    fill("BUY", 100, 10, { symbol: "AAPL" }),
    fill("BUY", 50, 20, { symbol: "TSLA" }),
    fill("SELL", 100, 11, { symbol: "AAPL" }),
    fill("SELL", 50, 19, { symbol: "TSLA" }),
  ]);
  expect(trades).toHaveLength(2);
  expect(trades.map((t) => t.symbol).sort()).toEqual(["AAPL", "TSLA"]);
});
```

- [ ] **Step 3: Run the suite to verify it fails**

Run: `bun test test/core/trade-builder.test.ts`
Expected: FAIL — cannot find module `../../src/core/trade-builder`.

- [ ] **Step 4: Implement `trade-builder`**

Create `src/core/trade-builder.ts`:
```ts
import type { Direction, RawFill, SeedPosition, Trade } from "../domain/types";

interface Acc {
  account: string;
  symbol: string;
  currency: string;
  direction: Direction;
  openTime: number;
  entryQty: number;
  entryValue: number;
  exitQty: number;
  exitValue: number;
  fees: number;
  maxQty: number;
  position: number; // signed
  fillIds: string[];
  lastTime: number;
  coverageOk: boolean;
}

function sign(n: number): number {
  return n === 0 ? 0 : n > 0 ? 1 : -1;
}

function groupKey(f: { account: string; symbol: string }): string {
  return `${f.account}|${f.symbol}`;
}

function newAcc(f: RawFill, direction: Direction, coverageOk: boolean): Acc {
  return {
    account: f.account,
    symbol: f.symbol,
    currency: f.currency,
    direction,
    openTime: f.time,
    entryQty: 0,
    entryValue: 0,
    exitQty: 0,
    exitValue: 0,
    fees: 0,
    maxQty: 0,
    position: 0,
    fillIds: [],
    lastTime: f.time,
    coverageOk,
  };
}

/** Apply a quantity portion of a fill as an entry (increasing exposure). */
function applyEntry(acc: Acc, f: RawFill, qty: number): void {
  acc.entryQty += qty;
  acc.entryValue += qty * f.price;
  acc.fees += f.fee * (qty / f.qty);
  acc.position += acc.direction === "LONG" ? qty : -qty;
  acc.maxQty = Math.max(acc.maxQty, Math.abs(acc.position));
  acc.lastTime = f.time;
  if (!acc.fillIds.includes(f.id)) acc.fillIds.push(f.id);
}

/** Apply a quantity portion of a fill as an exit (reducing exposure). */
function applyExit(acc: Acc, f: RawFill, qty: number): void {
  acc.exitQty += qty;
  acc.exitValue += qty * f.price;
  acc.fees += f.fee * (qty / f.qty);
  acc.position += acc.direction === "LONG" ? -qty : qty;
  acc.lastTime = f.time;
  if (!acc.fillIds.includes(f.id)) acc.fillIds.push(f.id);
}

function finalize(acc: Acc): Trade {
  const closed = acc.position === 0;
  const avgEntry = acc.entryQty > 0 ? acc.entryValue / acc.entryQty : 0;
  const avgExit = acc.exitQty > 0 ? acc.exitValue / acc.exitQty : null;
  let realizedPnl: number | null = null;
  if (closed) {
    realizedPnl =
      acc.direction === "LONG"
        ? acc.exitValue - acc.entryValue - acc.fees
        : acc.entryValue - acc.exitValue - acc.fees;
  }
  return {
    id: `${acc.account}:${acc.symbol}:${acc.openTime}`,
    account: acc.account,
    symbol: acc.symbol,
    currency: acc.currency,
    direction: acc.direction,
    status: closed ? "closed" : "open",
    openTime: acc.openTime,
    closeTime: closed ? acc.lastTime : null,
    avgEntry,
    avgExit,
    maxQty: acc.maxQty,
    realizedPnl,
    fees: acc.fees,
    holdSeconds: closed ? Math.round((acc.lastTime - acc.openTime) / 1000) : null,
    coverageOk: acc.coverageOk,
    fillIds: acc.fillIds,
  };
}

export function buildTrades(fills: RawFill[], seeds: SeedPosition[] = []): Trade[] {
  const seedMap = new Map<string, number>();
  for (const s of seeds) seedMap.set(groupKey(s), s.qty);

  const groups = new Map<string, RawFill[]>();
  for (const f of fills) {
    const k = groupKey(f);
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(f);
  }

  const trades: Trade[] = [];

  for (const [key, groupFills] of groups) {
    groupFills.sort((a, b) => a.time - b.time);
    const seedQty = seedMap.get(key) ?? 0;

    let position = 0;
    let acc: Acc | null = null;

    // Seed a pre-existing position: open an accumulator whose entry is unknown.
    if (seedQty !== 0) {
      const first = groupFills[0]!;
      acc = newAcc(first, seedQty > 0 ? "LONG" : "SHORT", false);
      acc.entryQty = Math.abs(seedQty);
      acc.position = seedQty;
      acc.maxQty = Math.abs(seedQty);
      acc.openTime = first.time; // best available; coverageOk=false marks it approximate
      position = seedQty;
    }

    for (const f of groupFills) {
      const signed = f.side === "BUY" ? f.qty : -f.qty;

      if (position === 0) {
        acc = newAcc(f, signed > 0 ? "LONG" : "SHORT", true);
        applyEntry(acc, f, f.qty);
        position = acc.position;
        continue;
      }

      if (sign(signed) === sign(position)) {
        applyEntry(acc!, f, f.qty); // adding in the same direction
        position = acc!.position;
        continue;
      }

      // reducing
      if (Math.abs(signed) <= Math.abs(position)) {
        applyExit(acc!, f, f.qty);
        position = acc!.position;
        if (position === 0) {
          trades.push(finalize(acc!));
          acc = null;
        }
      } else {
        // flip through zero: close current with the closing portion, open new with the rest
        const closingQty = Math.abs(position);
        const remaining = Math.abs(signed) - closingQty;
        applyExit(acc!, f, closingQty);
        trades.push(finalize(acc!));
        acc = newAcc(f, signed > 0 ? "LONG" : "SHORT", true);
        applyEntry(acc, f, remaining);
        position = acc.position;
      }
    }

    if (acc && position !== 0) trades.push(finalize(acc)); // leftover open trade
  }

  return trades;
}
```

- [ ] **Step 5: Run the suite to verify it passes**

Run: `bun test test/core/trade-builder.test.ts`
Expected: all tests pass (`10 pass, 0 fail`).

- [ ] **Step 6: Run the full test suite and typecheck**

Run: `bun test && bunx tsc --noEmit`
Expected: all pass, no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/core test/core test/helpers.ts
git commit -m "feat: trade-builder round-trip aggregation (scale, flip, open, seeded)"
```

---

## Plan 1 Complete — What Exists Now

- A scaffolded, typechecked Bun + TS project with a working test runner.
- A **go/no-go verdict** on the FUTU-via-Bun stack (Task 2), with real field names recorded for Plan 4.
- A SQLite persistence layer with versioned migrations and pre-migration backup.
- The **trade-builder** core, fully unit-tested against the tricky cases.

## Subsequent Plans (written after Plan 1 de-risks the stack)

- **Plan 2 — Pure core (rest):** `stop-inference`, `mae-mfe`, `rule-engine`, `analytics` — each TDD, all consuming `Trade`/`RawFill`/`RawOrder`. (Adds a `raw_orders` migration + `Trade` stop/excursion/flag fields.)
- **Plan 3 — Journaling & config:** `journal`, `journal_tags`, `journal_entries`, `watchlist_items` tables + repositories; config file loading. (Migrations + store repos, TDD.)
- **Plan 4 — FUTU client & sync:** real `futu-client` (replacing the spike), `candles` (single source), and the `sync` orchestrator; chunked/paced backfill with `coverage_start`. Integration-tested against recorded fixtures.
- **Plan 5 — API & web:** Bun HTTP API + React/Vite SPA (trades list → detail + Lightweight Charts → dashboard → open positions → weekly journal).
- **Plan 6 — Packaging & self-update:** `bun build --compile` per target, `app.main()` bootstrap (backup → migrate → serve → open browser), GitHub-Releases self-update, setup docs (incl. OpenD + macOS Gatekeeper).
```
