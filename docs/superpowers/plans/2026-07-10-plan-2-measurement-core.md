# FUTU Trade Review — Plan 2: Measurement Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the pure "measurement" layer on top of the trade foundation: infer each trade's protective stop/take-profit from order history, compute risk & R-multiple, and compute MAE/MFE from candles — plus the schema/type additions these need.

**Architecture:** Three new pure modules in `src/core/` (`stop-inference`, `risk`, `mae-mfe`), each unit-tested with fixtures and free of I/O. New domain types (`RawOrder`, `Candle`, `StopInfo`) and six new nullable enrichment fields on `Trade` (`effectiveStop`, `effectiveTp`, `risk`, `rMultiple`, `mae`, `mfe`), all defaulting to `null` from `trade-builder` and populated later by the sync pipeline (Plan 4). A v2 migration adds the matching `trades` columns plus the `raw_orders`, `raw_positions`, and `sync_state` tables.

**Tech Stack:** Bun, TypeScript, `bun:sqlite`, `bun test`. No new npm deps.

**Reference spec:** `docs/superpowers/specs/2026-07-10-futu-trade-review-design.md` (§5 data model, §6 stops/risk, §7 MAE/MFE). Builds on Plan 1 (merged): `src/domain/types.ts`, `src/core/trade-builder.ts`, `src/store/migrations.ts`.

---

## File Structure (Plan 2 scope)

```
src/
├── domain/
│   └── types.ts                 # MODIFY: add RawOrder, OrderType, Candle, StopInfo; extend Trade
├── core/
│   ├── trade-builder.ts         # MODIFY: finalize() sets the 6 new Trade fields to null
│   ├── stop-inference.ts        # NEW: inferStops(trade, orders) → StopInfo   (PURE)
│   ├── risk.ts                  # NEW: computeRisk(trade, stop) → {risk, rMultiple}  (PURE)
│   └── mae-mfe.ts               # NEW: computeExcursion(trade, candles) → {mae, mfe}  (PURE)
└── store/
    └── migrations.ts            # MODIFY: append v2 migration (columns + new tables)
test/
├── core/
│   ├── stop-inference.test.ts   # NEW
│   ├── risk.test.ts             # NEW
│   └── mae-mfe.test.ts          # NEW
├── store/
│   └── migrations.test.ts       # MODIFY: assert v2 tables/columns
└── helpers.ts                   # MODIFY: add order() + candle() builders
```

---

## Task 1: Domain types + v2 migration

**Files:**
- Modify: `src/domain/types.ts`
- Modify: `src/core/trade-builder.ts`
- Modify: `src/store/migrations.ts`
- Modify: `test/store/migrations.test.ts`

- [ ] **Step 1: Add the new types and extend `Trade`**

In `src/domain/types.ts`, append these types at the end of the file:
```ts
/** FUTU order type (normalized). Stop/stop-limit/trailing are protective-stop candidates. */
export type OrderType =
  | "MARKET"
  | "LIMIT"
  | "STOP"
  | "STOP_LIMIT"
  | "TRAILING_STOP"
  | "OTHER";

/** An order as returned by FUTU (including cancelled ones). Used to infer protective stops. */
export interface RawOrder {
  id: string;
  symbol: string;
  side: Side;
  type: OrderType;
  qty: number;
  price: number | null; // limit price; null for market/stop-market
  triggerPrice: number | null; // stop trigger; null for non-stop orders
  status: string; // raw FUTU status string (e.g. "FILLED_ALL", "CANCELLED_ALL")
  createTime: number; // epoch ms
  account: string;
}

/** An OHLC candle. Used for MAE/MFE and (later) charts. */
export interface Candle {
  time: number; // epoch ms, bar start
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Output of stop inference for one trade. */
export interface StopInfo {
  effectiveStop: number | null;
  effectiveTp: number | null;
}
```

Then extend the `Trade` interface — add these six fields immediately after the `fillIds: string[];` line (inside the interface), so the closing brace follows them:
```ts
  // Enrichment fields — null from trade-builder; populated by the sync pipeline (Plan 2+ modules).
  effectiveStop: number | null;
  effectiveTp: number | null;
  risk: number | null;
  rMultiple: number | null;
  mae: number | null;
  mfe: number | null;
```

- [ ] **Step 2: Make `trade-builder.finalize()` set the new fields to null**

In `src/core/trade-builder.ts`, in the object returned by `finalize()`, add these lines right after `fillIds: acc.fillIds,`:
```ts
    effectiveStop: null,
    effectiveTp: null,
    risk: null,
    rMultiple: null,
    mae: null,
    mfe: null,
```

- [ ] **Step 3: Verify existing tests + typecheck still pass**

Run: `bun test && bunx tsc --noEmit`
Expected: all existing tests pass (the new nullable fields don't affect existing assertions), tsc clean.

- [ ] **Step 4: Write the failing v2 migration test**

In `test/store/migrations.test.ts`, add these tests at the end of the file:
```ts
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
```

- [ ] **Step 5: Run the migration tests to verify they fail**

Run: `bun test test/store/migrations.test.ts`
Expected: the two new tests FAIL (tables/columns don't exist yet); the earlier "fresh db migrates to latest version" test may also fail because `MIGRATIONS.length` changes — that's expected until Step 6.

- [ ] **Step 6: Append the v2 migration**

In `src/store/migrations.ts`, add a second entry to the `MIGRATIONS` array (after the v1 function, before the closing `]`):
```ts
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
        status TEXT NOT NULL, create_time INTEGER NOT NULL, account TEXT NOT NULL
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
```

- [ ] **Step 7: Run the full suite + typecheck**

Run: `bun test && bunx tsc --noEmit`
Expected: all pass (migration tests now green, `MIGRATIONS.length` is 2), tsc clean.

- [ ] **Step 8: Commit**

```bash
git add src/domain/types.ts src/core/trade-builder.ts src/store/migrations.ts test/store/migrations.test.ts
git commit -m "feat: v2 schema + enrichment types (RawOrder, Candle, StopInfo, Trade fields)"
```

---

## Task 2: `stop-inference` (pure, TDD)

**Files:**
- Modify: `test/helpers.ts`
- Create: `test/core/stop-inference.test.ts`
- Create: `src/core/stop-inference.ts`

Reconstruct a trade's protective stop/TP by scanning orders on the same account+symbol during the trade's open window. Matching (spec §6): opposite side to the position; stop-type order below the entry (loss side) = stop-loss; limit order beyond the entry (profit side) = take-profit; qty ≤ trade's max size; placed within the open window. When several match, the **latest by `createTime`** wins.

- [ ] **Step 1: Add an `order()` builder to `test/helpers.ts`**

Append to `test/helpers.ts`:
```ts
import type { RawOrder, OrderType } from "../src/domain/types";

let oseq = 0;
export function order(
  side: Side,
  type: OrderType,
  qty: number,
  over: Partial<RawOrder> = {},
): RawOrder {
  oseq += 1;
  return {
    id: over.id ?? `ord${oseq}`,
    symbol: over.symbol ?? "AAPL",
    side,
    type,
    qty,
    price: over.price ?? null,
    triggerPrice: over.triggerPrice ?? null,
    status: over.status ?? "CANCELLED_ALL",
    createTime: over.createTime ?? oseq * 60_000,
    account: over.account ?? "acc1",
  };
}
```
(Adjust the existing top-of-file import to also import `RawOrder, OrderType` if not already covered — the file already imports from `../src/domain/types`.)

- [ ] **Step 2: Write the failing test suite**

Create `test/core/stop-inference.test.ts`:
```ts
import { test, expect } from "bun:test";
import { inferStops } from "../../src/core/stop-inference";
import { buildTrades } from "../../src/core/trade-builder";
import { fill, order } from "../helpers";

// A long trade opened at t=60000 (BUY 100 @ 10), still open.
function longTrade() {
  return buildTrades([fill("BUY", 100, 10, { time: 60_000 })])[0]!;
}

test("detects a separate protective SELL STOP for a long", () => {
  const t = longTrade();
  const orders = [order("SELL", "STOP", 100, { triggerPrice: 9, createTime: 120_000 })];
  expect(inferStops(t, orders).effectiveStop).toBe(9);
});

test("detects a take-profit limit above entry for a long", () => {
  const t = longTrade();
  const orders = [order("SELL", "LIMIT", 100, { price: 13, createTime: 120_000 })];
  expect(inferStops(t, orders).effectiveTp).toBe(13);
});

test("latest matching stop wins (stop was trailed up)", () => {
  const t = longTrade();
  const orders = [
    order("SELL", "STOP", 100, { triggerPrice: 9, createTime: 120_000 }),
    order("SELL", "STOP", 100, { triggerPrice: 9.5, createTime: 180_000 }),
  ];
  expect(inferStops(t, orders).effectiveStop).toBe(9.5);
});

test("ignores a BUY stop (wrong side for a long)", () => {
  const t = longTrade();
  const orders = [order("BUY", "STOP", 100, { triggerPrice: 9, createTime: 120_000 })];
  expect(inferStops(t, orders).effectiveStop).toBeNull();
});

test("ignores a stop on a bigger qty than the position", () => {
  const t = longTrade();
  const orders = [order("SELL", "STOP", 500, { triggerPrice: 9, createTime: 120_000 })];
  expect(inferStops(t, orders).effectiveStop).toBeNull();
});

test("ignores an order on a different symbol/account", () => {
  const t = longTrade();
  const orders = [
    order("SELL", "STOP", 100, { triggerPrice: 9, createTime: 120_000, symbol: "TSLA" }),
    order("SELL", "STOP", 100, { triggerPrice: 9, createTime: 120_000, account: "other" }),
  ];
  expect(inferStops(t, orders).effectiveStop).toBeNull();
});

test("ignores an order placed before the trade opened", () => {
  const t = longTrade(); // opens at 60000
  const orders = [order("SELL", "STOP", 100, { triggerPrice: 9, createTime: 30_000 })];
  expect(inferStops(t, orders).effectiveStop).toBeNull();
});

test("a SELL STOP above entry is not a stop-loss (wrong price side)", () => {
  const t = longTrade();
  const orders = [order("SELL", "STOP", 100, { triggerPrice: 11, createTime: 120_000 })];
  expect(inferStops(t, orders).effectiveStop).toBeNull();
});

test("short trade: BUY stop above entry is the stop-loss", () => {
  const short = buildTrades([fill("SELL", 100, 20, { time: 60_000 })])[0]!;
  const orders = [order("BUY", "STOP", 100, { triggerPrice: 22, createTime: 120_000 })];
  expect(inferStops(short, orders).effectiveStop).toBe(22);
});

test("no orders → null stop and tp", () => {
  const t = longTrade();
  expect(inferStops(t, [])).toEqual({ effectiveStop: null, effectiveTp: null });
});
```

- [ ] **Step 3: Run the suite to verify it fails**

Run: `bun test test/core/stop-inference.test.ts`
Expected: FAIL — cannot find module `../../src/core/stop-inference`.

- [ ] **Step 4: Implement `stop-inference`**

Create `src/core/stop-inference.ts`:
```ts
import type { RawOrder, StopInfo, Trade } from "../domain/types";

const STOP_TYPES = new Set(["STOP", "STOP_LIMIT", "TRAILING_STOP"]);
const EPS = 1e-9;

/** The side of an order that would REDUCE this trade's position. */
function closingSide(trade: Trade): "BUY" | "SELL" {
  return trade.direction === "LONG" ? "SELL" : "BUY";
}

/** Is the order within the trade's open window and on the same instrument/account/side/qty? */
function isProtective(trade: Trade, o: RawOrder): boolean {
  if (o.account !== trade.account || o.symbol !== trade.symbol) return false;
  if (o.side !== closingSide(trade)) return false;
  if (o.qty > trade.maxQty + EPS) return false;
  if (o.createTime < trade.openTime) return false;
  if (trade.closeTime !== null && o.createTime > trade.closeTime) return false;
  return true;
}

/** Latest-by-createTime value among matching orders, or null. */
function latest(orders: RawOrder[], pick: (o: RawOrder) => number | null): number | null {
  let best: RawOrder | null = null;
  let bestVal: number | null = null;
  for (const o of orders) {
    const v = pick(o);
    if (v === null) continue;
    if (best === null || o.createTime > best.createTime) {
      best = o;
      bestVal = v;
    }
  }
  return bestVal;
}

export function inferStops(trade: Trade, orders: RawOrder[]): StopInfo {
  const candidates = orders.filter((o) => isProtective(trade, o));

  // Stop-loss: a stop-type order with trigger on the LOSS side of entry.
  const stopVal = latest(candidates, (o) => {
    if (!STOP_TYPES.has(o.type) || o.triggerPrice === null) return null;
    const onLossSide =
      trade.direction === "LONG"
        ? o.triggerPrice < trade.avgEntry
        : o.triggerPrice > trade.avgEntry;
    return onLossSide ? o.triggerPrice : null;
  });

  // Take-profit: a limit order with price on the PROFIT side of entry.
  const tpVal = latest(candidates, (o) => {
    if (o.type !== "LIMIT" || o.price === null) return null;
    const onProfitSide =
      trade.direction === "LONG" ? o.price > trade.avgEntry : o.price < trade.avgEntry;
    return onProfitSide ? o.price : null;
  });

  return { effectiveStop: stopVal, effectiveTp: tpVal };
}
```

- [ ] **Step 5: Run the suite to verify it passes**

Run: `bun test test/core/stop-inference.test.ts`
Expected: all pass (`10 pass, 0 fail`).

- [ ] **Step 6: Full suite + typecheck, then commit**

```bash
bun test && bunx tsc --noEmit
git add src/core/stop-inference.ts test/core/stop-inference.test.ts test/helpers.ts
git commit -m "feat: stop-inference — reconstruct protective stop/TP from order history"
```

---

## Task 3: `risk` — risk & R-multiple (pure, TDD)

**Files:**
- Create: `test/core/risk.test.ts`
- Create: `src/core/risk.ts`

`risk = |avgEntry − stop| × maxQty` (dollar risk). `rMultiple = realizedPnl / risk`, only for a **closed** trade with a known stop and positive risk; otherwise both are null.

- [ ] **Step 1: Write the failing test**

Create `test/core/risk.test.ts`:
```ts
import { test, expect } from "bun:test";
import { computeRisk } from "../../src/core/risk";
import { buildTrades } from "../../src/core/trade-builder";
import { fill } from "../helpers";

function closedLong() {
  // BUY 100 @ 10, SELL 100 @ 12 → realizedPnl 200.
  return buildTrades([fill("BUY", 100, 10), fill("SELL", 100, 12)])[0]!;
}

test("risk = |entry - stop| * maxQty; R = pnl / risk", () => {
  const t = closedLong();
  const r = computeRisk(t, 9); // risk per share = 1, size 100 → risk 100; pnl 200 → 2R
  expect(r.risk).toBe(100);
  expect(r.rMultiple).toBe(2);
});

test("null stop → null risk and null R", () => {
  const t = closedLong();
  expect(computeRisk(t, null)).toEqual({ risk: null, rMultiple: null });
});

test("open trade → risk computed but R is null (no realized pnl)", () => {
  const openT = buildTrades([fill("BUY", 100, 10)])[0]!;
  const r = computeRisk(openT, 9);
  expect(r.risk).toBe(100);
  expect(r.rMultiple).toBeNull();
});

test("zero risk (stop equals entry) → null R, not Infinity", () => {
  const t = closedLong();
  const r = computeRisk(t, 10);
  expect(r.risk).toBe(0);
  expect(r.rMultiple).toBeNull();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/core/risk.test.ts`
Expected: FAIL — cannot find module `../../src/core/risk`.

- [ ] **Step 3: Implement `risk`**

Create `src/core/risk.ts`:
```ts
import type { Trade } from "../domain/types";

const EPS = 1e-9;

/** Dollar risk and R-multiple for a trade given its (possibly null) stop price. */
export function computeRisk(
  trade: Trade,
  stop: number | null,
): { risk: number | null; rMultiple: number | null } {
  if (stop === null) return { risk: null, rMultiple: null };

  const risk = Math.abs(trade.avgEntry - stop) * trade.maxQty;

  let rMultiple: number | null = null;
  if (trade.status === "closed" && trade.realizedPnl !== null && risk > EPS) {
    rMultiple = trade.realizedPnl / risk;
  }
  return { risk, rMultiple };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test test/core/risk.test.ts`
Expected: `4 pass, 0 fail`.

- [ ] **Step 5: Full suite + typecheck, then commit**

```bash
bun test && bunx tsc --noEmit
git add src/core/risk.ts test/core/risk.test.ts
git commit -m "feat: risk — dollar risk and R-multiple from trade + stop"
```

---

## Task 4: `mae-mfe` — excursion (pure, TDD)

**Files:**
- Modify: `test/helpers.ts`
- Create: `test/core/mae-mfe.test.ts`
- Create: `src/core/mae-mfe.ts`

Given the candles overlapping a trade's window, compute **MAE** (max adverse excursion) and **MFE** (max favorable excursion) in **price points per share**, from the trade's `avgEntry`. For a LONG: MFE = `max(high) − avgEntry`, MAE = `avgEntry − min(low)`. For a SHORT: MFE = `avgEntry − min(low)`, MAE = `max(high) − avgEntry`. Both are `≥ 0`; `null` when no candles fall in the window. Window = `[openTime, closeTime ?? +∞]`.

- [ ] **Step 1: Add a `candle()` builder to `test/helpers.ts`**

Append to `test/helpers.ts`:
```ts
import type { Candle } from "../src/domain/types";

export function candle(time: number, low: number, high: number, over: Partial<Candle> = {}): Candle {
  return {
    time,
    open: over.open ?? (low + high) / 2,
    high,
    low,
    close: over.close ?? (low + high) / 2,
    volume: over.volume ?? 1000,
  };
}
```

- [ ] **Step 2: Write the failing test**

Create `test/core/mae-mfe.test.ts`:
```ts
import { test, expect } from "bun:test";
import { computeExcursion } from "../../src/core/mae-mfe";
import { buildTrades } from "../../src/core/trade-builder";
import { fill, candle } from "../helpers";

function longTrade() {
  // BUY 100 @ 10 at t=60000, SELL 100 @ 12 at t=180000 → window [60000, 180000].
  return buildTrades([
    fill("BUY", 100, 10, { time: 60_000 }),
    fill("SELL", 100, 12, { time: 180_000 }),
  ])[0]!;
}

test("long: MFE from highest high, MAE from lowest low", () => {
  const t = longTrade();
  const candles = [
    candle(60_000, 9, 11), // low 9, high 11
    candle(120_000, 8, 13), // low 8 (worst), high 13 (best)
  ];
  const r = computeExcursion(t, candles);
  expect(r.mfe).toBe(3); // 13 - 10
  expect(r.mae).toBe(2); // 10 - 8
});

test("short: MFE from lowest low, MAE from highest high", () => {
  const short = buildTrades([
    fill("SELL", 100, 20, { time: 60_000 }),
    fill("BUY", 100, 18, { time: 180_000 }),
  ])[0]!;
  const candles = [candle(120_000, 17, 23)]; // low 17, high 23; entry 20
  const r = computeExcursion(short, candles);
  expect(r.mfe).toBe(3); // 20 - 17
  expect(r.mae).toBe(3); // 23 - 20
});

test("candles outside the trade window are ignored", () => {
  const t = longTrade(); // window [60000, 180000]
  const candles = [
    candle(30_000, 1, 100), // before open — ignored
    candle(240_000, 1, 100), // after close — ignored
    candle(120_000, 9, 11),
  ];
  const r = computeExcursion(t, candles);
  expect(r.mfe).toBe(1); // 11 - 10
  expect(r.mae).toBe(1); // 10 - 9
});

test("no candles in window → null", () => {
  const t = longTrade();
  expect(computeExcursion(t, [])).toEqual({ mae: null, mfe: null });
});

test("open trade uses all candles from openTime onward", () => {
  const openT = buildTrades([fill("BUY", 100, 10, { time: 60_000 })])[0]!;
  const candles = [candle(600_000, 8, 15)];
  const r = computeExcursion(openT, candles);
  expect(r.mfe).toBe(5); // 15 - 10
  expect(r.mae).toBe(2); // 10 - 8
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `bun test test/core/mae-mfe.test.ts`
Expected: FAIL — cannot find module `../../src/core/mae-mfe`.

- [ ] **Step 4: Implement `mae-mfe`**

Create `src/core/mae-mfe.ts`:
```ts
import type { Candle, Trade } from "../domain/types";

/** Max adverse/favorable excursion in price points per share, from the trade's avgEntry. */
export function computeExcursion(
  trade: Trade,
  candles: Candle[],
): { mae: number | null; mfe: number | null } {
  const end = trade.closeTime ?? Number.POSITIVE_INFINITY;
  const inWindow = candles.filter((c) => c.time >= trade.openTime && c.time <= end);
  if (inWindow.length === 0) return { mae: null, mfe: null };

  let hi = Number.NEGATIVE_INFINITY;
  let lo = Number.POSITIVE_INFINITY;
  for (const c of inWindow) {
    if (c.high > hi) hi = c.high;
    if (c.low < lo) lo = c.low;
  }

  if (trade.direction === "LONG") {
    return { mfe: hi - trade.avgEntry, mae: trade.avgEntry - lo };
  }
  return { mfe: trade.avgEntry - lo, mae: hi - trade.avgEntry };
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `bun test test/core/mae-mfe.test.ts`
Expected: `5 pass, 0 fail`.

- [ ] **Step 6: Full suite + typecheck, then commit**

```bash
bun test && bunx tsc --noEmit
git add src/core/mae-mfe.ts test/core/mae-mfe.test.ts test/helpers.ts
git commit -m "feat: mae-mfe — max adverse/favorable excursion from candles"
```

---

## Plan 2 Complete — What Exists Now

- Domain types for orders, candles, stop info; `Trade` carries enrichment fields.
- v2 schema: enrichment columns on `trades`; `raw_orders`, `raw_positions`, `sync_state` tables.
- Three pure, tested modules: `stop-inference`, `risk`, `mae-mfe`.

## Next: Plan 3 — Judgment core

- `rule-engine` (the six mistake flags — consumes enriched trades + fills + candles + recent-trade context + config) and `analytics` (currency-aware KPIs + breakdowns by setup/tag/symbol/hold-time). Both pure, TDD. After Plan 3, Plan 4 wires the real `futu-client` + `candles` source + `sync` orchestrator.
```
