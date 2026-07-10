# FUTU Trade Review — Plan 3: Judgment Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the two pure modules that turn measured trades into insight: `analytics` (currency-aware KPIs + flexible breakdowns) and `rule-engine` (the six transparent "mistake" flags).

**Architecture:** Two pure modules in `src/core/`, unit-tested with fixtures, no I/O. `analytics` reads enriched `Trade`s and produces per-currency stats plus a generic `breakdown(trades, keyFn)` so callers group by symbol, hold-time, or (later) journal setup/tag without analytics knowing about journaling. `rule-engine` evaluates one trade against a context (its fills, candles, recent closed trades) + a config of thresholds/toggles, returning `Flag[]`. New types: `Flag`, `RuleConfig`, `RuleContext`, and the analytics result types. A v3 migration adds the `flags` table and a `config` table.

**Tech Stack:** Bun, TypeScript, `bun:sqlite`, `bun test`. No new npm deps.

**Reference spec:** `docs/superpowers/specs/2026-07-10-futu-trade-review-design.md` (§7 analytics, §8/§9 rule engine, §10 journaling model, §5 data model). Builds on Plans 1–2 (merged): enriched `Trade` (has `effectiveStop`, `risk`, `rMultiple`, `mae`, `mfe`), `RawFill`, `Candle`.

---

## File Structure (Plan 3 scope)

```
src/
├── domain/
│   └── types.ts             # MODIFY: add Flag, RuleConfig, DEFAULT_RULE_CONFIG, RuleContext,
│   │                        #         CurrencyStats, Breakdown, Stats
│   └── ...
├── core/
│   ├── analytics.ts         # NEW: computeStats(trades) + breakdown(trades, keyFn)  (PURE)
│   └── rule-engine.ts       # NEW: evaluate(trade, ctx, config) → Flag[]            (PURE)
└── store/
    └── migrations.ts        # MODIFY: append v3 migration (flags + config tables)
test/
├── core/
│   ├── analytics.test.ts    # NEW
│   └── rule-engine.test.ts  # NEW
└── store/migrations.test.ts # MODIFY: assert v3 tables
```

---

## Task 1: Types + v3 migration

**Files:**
- Modify: `src/domain/types.ts`
- Modify: `src/store/migrations.ts`
- Modify: `test/store/migrations.test.ts`

- [ ] **Step 1: Add the new types**

Append to `src/domain/types.ts`:
```ts
/** A fired mistake-rule result, with a plain-English reason. */
export interface Flag {
  ruleId: string;
  severity: "info" | "warn";
  reason: string;
}

/** Tunable thresholds + per-rule on/off. Loaded from the config file (no settings UI in v1). */
export interface RuleConfig {
  cutWinnerR: number; // flag a winner exited for less than this R (default 1)
  oversizedMult: number; // flag risk above this multiple of recent-average risk (default 1.5)
  roundTripR: number; // flag a give-back when peak gain reached this many R (default 1)
  revengeMinutes: number; // flag a new trade opened within this many minutes of a losing exit (default 30)
  enabled: Record<string, boolean>; // ruleId → enabled; missing key = enabled
}

export const DEFAULT_RULE_CONFIG: RuleConfig = {
  cutWinnerR: 1,
  oversizedMult: 1.5,
  roundTripR: 1,
  revengeMinutes: 30,
  enabled: {},
};

/** Everything a rule may need beyond the trade itself. */
export interface RuleContext {
  fills: RawFill[]; // the fills composing THIS trade
  candles: Candle[]; // candles overlapping the trade window
  resolution: number; // candle bar duration (ms)
  recentClosedTrades: Trade[]; // prior closed trades in the same account (for averages + timing)
}

/** Per-currency aggregate stats (P&L is never summed across currencies). */
export interface CurrencyStats {
  currency: string;
  netPnl: number;
  tradeCount: number;
  winRate: number; // 0..1
  avgWin: number;
  avgLoss: number; // positive magnitude of the average loss
  expectancy: number; // winRate*avgWin - lossRate*avgLoss
  avgR: number | null; // mean rMultiple over trades that have one
  avgMae: number | null;
  avgMfe: number | null;
  equityCurve: Array<{ time: number; cumPnl: number }>;
}

/** One row of a grouped breakdown (by symbol, setup, tag, hold-time bucket, …). */
export interface Breakdown {
  key: string;
  netPnl: number;
  tradeCount: number;
  winRate: number;
  avgR: number | null;
}

export interface Stats {
  byCurrency: CurrencyStats[];
}
```

- [ ] **Step 2: Typecheck**

Run: `bunx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Write the failing v3 migration test**

Append to `test/store/migrations.test.ts`:
```ts
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
```

- [ ] **Step 4: Run to verify it fails**

Run: `bun test test/store/migrations.test.ts`
Expected: the new test FAILS (and "fresh db migrates to latest version" fails until Step 5, since `MIGRATIONS.length` changes).

- [ ] **Step 5: Append the v3 migration**

Add a third entry to the `MIGRATIONS` array in `src/store/migrations.ts` (after v2, before the closing `]`):
```ts
  // v3 — computed flags + config key/value store
  (db) => {
    db.run(`
      CREATE TABLE flags (
        trade_id TEXT NOT NULL, rule_id TEXT NOT NULL,
        severity TEXT NOT NULL, reason TEXT NOT NULL,
        PRIMARY KEY (trade_id, rule_id)
      );
    `);
    db.run(`
      CREATE TABLE config (
        key TEXT PRIMARY KEY, value TEXT NOT NULL
      );
    `);
  },
```

- [ ] **Step 6: Run the full suite + typecheck**

Run: `bun test && bunx tsc --noEmit`
Expected: all pass (`MIGRATIONS.length` now 3), tsc clean.

- [ ] **Step 7: Commit**

```bash
git add src/domain/types.ts src/store/migrations.ts test/store/migrations.test.ts
git commit -m "feat: v3 schema + judgment types (Flag, RuleConfig, RuleContext, Stats)"
```

---

## Task 2: `analytics` (pure, TDD)

**Files:**
- Create: `test/core/analytics.test.ts`
- Create: `src/core/analytics.ts`

`computeStats` aggregates **closed, coverage-ok** trades, **segmented by currency** (never summed across). `breakdown` groups any trade list by a caller-supplied key function (trades with a `null` key are skipped) — this is how "by setup/tag/symbol/hold-time" is done without analytics knowing about journaling.

- [ ] **Step 1: Write the failing test**

Create `test/core/analytics.test.ts`:
```ts
import { test, expect } from "bun:test";
import { computeStats, breakdown } from "../../src/core/analytics";
import type { Trade } from "../../src/domain/types";

// Minimal closed-trade factory (only the fields analytics reads).
function tr(over: Partial<Trade>): Trade {
  return {
    id: over.id ?? "t",
    account: "acc1",
    symbol: over.symbol ?? "AAPL",
    currency: over.currency ?? "USD",
    direction: "LONG",
    status: "closed",
    openTime: over.openTime ?? 1000,
    closeTime: over.closeTime ?? 2000,
    avgEntry: 10,
    avgExit: 11,
    maxQty: 100,
    realizedPnl: over.realizedPnl ?? 0,
    fees: 0,
    holdSeconds: 0,
    coverageOk: over.coverageOk ?? true,
    fillIds: [],
    effectiveStop: null,
    effectiveTp: null,
    risk: null,
    rMultiple: over.rMultiple ?? null,
    mae: over.mae ?? null,
    mfe: over.mfe ?? null,
  };
}

test("segments P&L by currency; never sums across currencies", () => {
  const s = computeStats([
    tr({ currency: "USD", realizedPnl: 100 }),
    tr({ currency: "USD", realizedPnl: -40 }),
    tr({ currency: "HKD", realizedPnl: 500 }),
  ]);
  const usd = s.byCurrency.find((c) => c.currency === "USD")!;
  const hkd = s.byCurrency.find((c) => c.currency === "HKD")!;
  expect(usd.netPnl).toBe(60);
  expect(usd.tradeCount).toBe(2);
  expect(hkd.netPnl).toBe(500);
});

test("win rate, avg win/loss, expectancy", () => {
  const s = computeStats([
    tr({ realizedPnl: 200 }),
    tr({ realizedPnl: 100 }),
    tr({ realizedPnl: -100 }),
    tr({ realizedPnl: -50 }),
  ]);
  const usd = s.byCurrency[0]!;
  expect(usd.winRate).toBe(0.5);
  expect(usd.avgWin).toBe(150);
  expect(usd.avgLoss).toBe(75); // positive magnitude
  expect(usd.expectancy).toBe(0.5 * 150 - 0.5 * 75); // 37.5
});

test("avgR/avgMae/avgMfe ignore trades that lack them; null when none", () => {
  const s = computeStats([
    tr({ realizedPnl: 10, rMultiple: 2, mae: 1, mfe: 3 }),
    tr({ realizedPnl: 10, rMultiple: 4, mae: 3, mfe: 5 }),
    tr({ realizedPnl: 10 }), // no R/mae/mfe
  ]);
  const usd = s.byCurrency[0]!;
  expect(usd.avgR).toBe(3); // (2+4)/2
  expect(usd.avgMae).toBe(2);
  expect(usd.avgMfe).toBe(4);

  const none = computeStats([tr({ realizedPnl: 10 })]).byCurrency[0]!;
  expect(none.avgR).toBeNull();
});

test("excludes open and non-coverage trades", () => {
  const open = tr({ realizedPnl: 999 });
  open.status = "open";
  const s = computeStats([
    tr({ realizedPnl: 100 }),
    open,
    tr({ realizedPnl: 5, coverageOk: false }),
  ]);
  expect(s.byCurrency[0]!.tradeCount).toBe(1);
  expect(s.byCurrency[0]!.netPnl).toBe(100);
});

test("equity curve is cumulative in time order", () => {
  const s = computeStats([
    tr({ realizedPnl: 100, closeTime: 3000 }),
    tr({ realizedPnl: -30, closeTime: 1000 }),
    tr({ realizedPnl: 50, closeTime: 2000 }),
  ]);
  expect(s.byCurrency[0]!.equityCurve).toEqual([
    { time: 1000, cumPnl: -30 },
    { time: 2000, cumPnl: 20 },
    { time: 3000, cumPnl: 120 },
  ]);
});

test("empty input → no currency rows", () => {
  expect(computeStats([]).byCurrency).toEqual([]);
});

test("breakdown groups by a key function and skips null keys", () => {
  const rows = breakdown(
    [
      tr({ symbol: "AAPL", realizedPnl: 100 }),
      tr({ symbol: "AAPL", realizedPnl: -20 }),
      tr({ symbol: "TSLA", realizedPnl: 50 }),
      tr({ symbol: "SKIP", realizedPnl: 999 }),
    ],
    (t) => (t.symbol === "SKIP" ? null : t.symbol),
  );
  const aapl = rows.find((r) => r.key === "AAPL")!;
  expect(aapl.netPnl).toBe(80);
  expect(aapl.tradeCount).toBe(2);
  expect(aapl.winRate).toBe(0.5);
  expect(rows.find((r) => r.key === "SKIP")).toBeUndefined();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/core/analytics.test.ts`
Expected: FAIL — cannot find module `../../src/core/analytics`.

- [ ] **Step 3: Implement `analytics`**

Create `src/core/analytics.ts`:
```ts
import type { Breakdown, CurrencyStats, Stats, Trade } from "../domain/types";

/** Closed, coverage-ok trades with a realized P&L are the basis for all stats. */
function eligible(trades: Trade[]): Trade[] {
  return trades.filter((t) => t.status === "closed" && t.coverageOk && t.realizedPnl !== null);
}

function mean(xs: number[]): number | null {
  return xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function summarize(trades: Trade[]): Omit<CurrencyStats, "currency" | "equityCurve"> {
  const pnls = trades.map((t) => t.realizedPnl as number);
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p < 0);
  const netPnl = pnls.reduce((a, b) => a + b, 0);
  const winRate = trades.length === 0 ? 0 : wins.length / trades.length;
  const lossRate = trades.length === 0 ? 0 : losses.length / trades.length;
  const avgWin = wins.length === 0 ? 0 : wins.reduce((a, b) => a + b, 0) / wins.length;
  const avgLossMag =
    losses.length === 0 ? 0 : Math.abs(losses.reduce((a, b) => a + b, 0) / losses.length);
  return {
    netPnl,
    tradeCount: trades.length,
    winRate,
    avgWin,
    avgLoss: avgLossMag,
    expectancy: winRate * avgWin - lossRate * avgLossMag,
    avgR: mean(trades.filter((t) => t.rMultiple !== null).map((t) => t.rMultiple as number)),
    avgMae: mean(trades.filter((t) => t.mae !== null).map((t) => t.mae as number)),
    avgMfe: mean(trades.filter((t) => t.mfe !== null).map((t) => t.mfe as number)),
  };
}

export function computeStats(trades: Trade[]): Stats {
  const rows = eligible(trades);
  const byCurrency = new Map<string, Trade[]>();
  for (const t of rows) {
    let arr = byCurrency.get(t.currency);
    if (!arr) {
      arr = [];
      byCurrency.set(t.currency, arr);
    }
    arr.push(t);
  }

  const out: CurrencyStats[] = [];
  for (const [currency, ts] of byCurrency) {
    const sorted = ts
      .slice()
      .sort((a, b) => (a.closeTime ?? 0) - (b.closeTime ?? 0) || a.id.localeCompare(b.id));
    let cum = 0;
    const equityCurve = sorted.map((t) => {
      cum += t.realizedPnl as number;
      return { time: t.closeTime as number, cumPnl: cum };
    });
    out.push({ currency, ...summarize(ts), equityCurve });
  }
  return { byCurrency: out };
}

/** Group eligible trades by a caller key; trades whose key is null are skipped. */
export function breakdown(trades: Trade[], keyFn: (t: Trade) => string | null): Breakdown[] {
  const groups = new Map<string, Trade[]>();
  for (const t of eligible(trades)) {
    const k = keyFn(t);
    if (k === null) continue;
    let arr = groups.get(k);
    if (!arr) {
      arr = [];
      groups.set(k, arr);
    }
    arr.push(t);
  }
  const rows: Breakdown[] = [];
  for (const [key, ts] of groups) {
    const s = summarize(ts);
    rows.push({ key, netPnl: s.netPnl, tradeCount: s.tradeCount, winRate: s.winRate, avgR: s.avgR });
  }
  return rows;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test test/core/analytics.test.ts`
Expected: `7 pass, 0 fail`.

- [ ] **Step 5: Full suite + typecheck, then commit**

```bash
bun test && bunx tsc --noEmit
git add src/core/analytics.ts test/core/analytics.test.ts
git commit -m "feat: analytics — currency-segmented stats + flexible breakdowns"
```

---

## Task 3: `rule-engine` (pure, TDD)

**Files:**
- Create: `test/core/rule-engine.test.ts`
- Create: `src/core/rule-engine.ts`

`evaluate(trade, ctx, config)` returns a `Flag[]` — every rule that fires. Each rule is a small predicate; a disabled rule (via `config.enabled[ruleId] === false`) never fires; a rule missing its inputs is skipped, not errored. All values read off the enriched `Trade` (`risk`, `rMultiple`, `mae`, `mfe`, `effectiveStop`) or the `ctx`.

- [ ] **Step 1: Write the failing test**

Create `test/core/rule-engine.test.ts`:
```ts
import { test, expect } from "bun:test";
import { evaluate } from "../../src/core/rule-engine";
import { buildTrades } from "../../src/core/trade-builder";
import { fill } from "../helpers";
import { DEFAULT_RULE_CONFIG, type RuleContext, type Trade } from "../../src/domain/types";

function ctx(over: Partial<RuleContext> = {}): RuleContext {
  return {
    fills: over.fills ?? [],
    candles: over.candles ?? [],
    resolution: over.resolution ?? 60_000,
    recentClosedTrades: over.recentClosedTrades ?? [],
  };
}
function ids(flags: { ruleId: string }[]): string[] {
  return flags.map((f) => f.ruleId).sort();
}

test("added_to_loser: a long adds while underwater", () => {
  const fills = [
    fill("BUY", 100, 10, { time: 1000 }),
    fill("BUY", 100, 9, { time: 2000 }), // adding at 9 < avg 10 → adding to a loser
    fill("SELL", 200, 9.5, { time: 3000 }),
  ];
  const trade = buildTrades(fills)[0]!;
  const flags = evaluate(trade, ctx({ fills }), DEFAULT_RULE_CONFIG);
  expect(ids(flags)).toContain("added_to_loser");
});

test("added_to_loser: adding to a winner does NOT fire", () => {
  const fills = [
    fill("BUY", 100, 10, { time: 1000 }),
    fill("BUY", 100, 11, { time: 2000 }), // adding higher — not underwater
    fill("SELL", 200, 12, { time: 3000 }),
  ];
  const trade = buildTrades(fills)[0]!;
  const flags = evaluate(trade, ctx({ fills }), DEFAULT_RULE_CONFIG);
  expect(ids(flags)).not.toContain("added_to_loser");
});

test("cut_winner_early: closed winner under 1R", () => {
  const trade = { ...base(), realizedPnl: 50, rMultiple: 0.4 };
  expect(ids(evaluate(trade, ctx(), DEFAULT_RULE_CONFIG))).toContain("cut_winner_early");
});

test("cut_winner_early: a 2R winner does NOT fire", () => {
  const trade = { ...base(), realizedPnl: 200, rMultiple: 2 };
  expect(ids(evaluate(trade, ctx(), DEFAULT_RULE_CONFIG))).not.toContain("cut_winner_early");
});

test("held_past_stop: adverse excursion beyond the stop distance", () => {
  // entry 10, stop 9 → stop distance 1; mae 1.5 → went past the stop.
  const trade = { ...base(), effectiveStop: 9, mae: 1.5 };
  expect(ids(evaluate(trade, ctx(), DEFAULT_RULE_CONFIG))).toContain("held_past_stop");
});

test("held_past_stop: mae within the stop does NOT fire", () => {
  const trade = { ...base(), effectiveStop: 9, mae: 0.5 };
  expect(ids(evaluate(trade, ctx(), DEFAULT_RULE_CONFIG))).not.toContain("held_past_stop");
});

test("oversized: risk above 1.5x recent average", () => {
  const recent = [
    { ...base(), risk: 100 },
    { ...base(), risk: 100 },
  ];
  const trade = { ...base(), risk: 200 }; // 2x avg 100
  const flags = evaluate(trade, ctx({ recentClosedTrades: recent }), DEFAULT_RULE_CONFIG);
  expect(ids(flags)).toContain("oversized");
});

test("round_tripped_gain: peak >= 1R then closed red", () => {
  // risk 100, mfe 2/share * 100 qty = 200 peak gain (2R), exited at -10.
  const trade = { ...base(), risk: 100, maxQty: 100, mfe: 2, realizedPnl: -10 };
  expect(ids(evaluate(trade, ctx(), DEFAULT_RULE_CONFIG))).toContain("round_tripped_gain");
});

test("overtrading_revenge: opened soon after a losing exit", () => {
  const loser = { ...base(), realizedPnl: -50, closeTime: 1_000_000 };
  const trade = { ...base(), openTime: 1_000_000 + 5 * 60_000 }; // 5 min later
  const flags = evaluate(trade, ctx({ recentClosedTrades: [loser] }), DEFAULT_RULE_CONFIG);
  expect(ids(flags)).toContain("overtrading_revenge");
});

test("overtrading_revenge: after a WINNER does not fire", () => {
  const winner = { ...base(), realizedPnl: 50, closeTime: 1_000_000 };
  const trade = { ...base(), openTime: 1_000_000 + 5 * 60_000 };
  const flags = evaluate(trade, ctx({ recentClosedTrades: [winner] }), DEFAULT_RULE_CONFIG);
  expect(ids(flags)).not.toContain("overtrading_revenge");
});

test("a disabled rule never fires", () => {
  const trade = { ...base(), realizedPnl: 50, rMultiple: 0.4 };
  const cfg = { ...DEFAULT_RULE_CONFIG, enabled: { cut_winner_early: false } };
  expect(ids(evaluate(trade, ctx(), cfg))).not.toContain("cut_winner_early");
});

// A closed LONG trade with no enrichment set; individual tests override fields.
function base(): Trade {
  return {
    id: "t",
    account: "acc1",
    symbol: "AAPL",
    currency: "USD",
    direction: "LONG",
    status: "closed",
    openTime: 1000,
    closeTime: 2000,
    avgEntry: 10,
    avgExit: 11,
    maxQty: 100,
    realizedPnl: 100,
    fees: 0,
    holdSeconds: 1,
    coverageOk: true,
    fillIds: [],
    effectiveStop: null,
    effectiveTp: null,
    risk: null,
    rMultiple: null,
    mae: null,
    mfe: null,
  };
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/core/rule-engine.test.ts`
Expected: FAIL — cannot find module `../../src/core/rule-engine`.

- [ ] **Step 3: Implement `rule-engine`**

Create `src/core/rule-engine.ts`:
```ts
import type { Flag, RawFill, RuleConfig, RuleContext, Trade } from "../domain/types";

const EPS = 1e-9;

function on(config: RuleConfig, ruleId: string): boolean {
  return config.enabled[ruleId] !== false; // missing = enabled
}

/** Did the trader add to the position while it was underwater? Walk the fills. */
function addedToLoser(trade: Trade, fills: RawFill[]): boolean {
  const chrono = fills
    .slice()
    .sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
  let qty = 0; // signed
  let costQty = 0;
  let costVal = 0;
  for (const f of chrono) {
    const signed = f.side === "BUY" ? f.qty : -f.qty;
    const isAdd = qty === 0 ? true : Math.sign(signed) === Math.sign(qty);
    if (isAdd && qty !== 0) {
      const avg = costVal / costQty;
      // Long underwater when the add price is below avg cost; short when above.
      if (trade.direction === "LONG" ? f.price < avg - EPS : f.price > avg + EPS) return true;
    }
    if (isAdd) {
      costQty += f.qty;
      costVal += f.qty * f.price;
      qty += signed;
    } else {
      qty += signed; // reducing — leave cost basis as-is for this simple check
    }
  }
  return false;
}

function avgRecentRisk(recent: Trade[]): number | null {
  const risks = recent.filter((t) => t.risk !== null).map((t) => t.risk as number);
  if (risks.length === 0) return null;
  return risks.reduce((a, b) => a + b, 0) / risks.length;
}

export function evaluate(trade: Trade, ctx: RuleContext, config: RuleConfig): Flag[] {
  const flags: Flag[] = [];
  const add = (ruleId: string, severity: "info" | "warn", reason: string) => {
    if (on(config, ruleId)) flags.push({ ruleId, severity, reason });
  };

  // added_to_loser
  if (on(config, "added_to_loser") && addedToLoser(trade, ctx.fills)) {
    add("added_to_loser", "warn", "Increased size while the position was underwater.");
  }

  // cut_winner_early
  if (
    on(config, "cut_winner_early") &&
    trade.status === "closed" &&
    trade.realizedPnl !== null &&
    trade.realizedPnl > 0 &&
    trade.rMultiple !== null &&
    trade.rMultiple < config.cutWinnerR
  ) {
    add(
      "cut_winner_early",
      "info",
      `Exited a winner for ${trade.rMultiple.toFixed(2)}R (< ${config.cutWinnerR}R).`,
    );
  }

  // held_past_stop
  if (
    on(config, "held_past_stop") &&
    trade.effectiveStop !== null &&
    trade.mae !== null &&
    trade.mae > Math.abs(trade.avgEntry - trade.effectiveStop) + EPS
  ) {
    add("held_past_stop", "warn", "Price moved beyond your stop but the trade was still held.");
  }

  // oversized
  if (on(config, "oversized") && trade.risk !== null) {
    const avg = avgRecentRisk(ctx.recentClosedTrades);
    if (avg !== null && avg > EPS && trade.risk > config.oversizedMult * avg) {
      add(
        "oversized",
        "warn",
        `Risk was ${(trade.risk / avg).toFixed(1)}x your recent average.`,
      );
    }
  }

  // round_tripped_gain
  if (
    on(config, "round_tripped_gain") &&
    trade.status === "closed" &&
    trade.realizedPnl !== null &&
    trade.realizedPnl <= 0 &&
    trade.mfe !== null &&
    trade.risk !== null &&
    trade.risk > EPS &&
    trade.mfe * trade.maxQty >= config.roundTripR * trade.risk
  ) {
    add("round_tripped_gain", "info", "Gave back a gain that reached your target and closed flat/red.");
  }

  // overtrading_revenge
  if (on(config, "overtrading_revenge")) {
    const windowMs = config.revengeMinutes * 60_000;
    const revenge = ctx.recentClosedTrades.some(
      (p) =>
        p.realizedPnl !== null &&
        p.realizedPnl < 0 &&
        p.closeTime !== null &&
        trade.openTime - p.closeTime >= 0 &&
        trade.openTime - p.closeTime <= windowMs,
    );
    if (revenge) {
      add(
        "overtrading_revenge",
        "warn",
        `Opened within ${config.revengeMinutes} min of closing a losing trade.`,
      );
    }
  }

  return flags;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test test/core/rule-engine.test.ts`
Expected: all pass (`12 pass, 0 fail`).

- [ ] **Step 5: Full suite + typecheck, then commit**

```bash
bun test && bunx tsc --noEmit
git add src/core/rule-engine.ts test/core/rule-engine.test.ts
git commit -m "feat: rule-engine — six transparent mistake flags"
```

---

## Plan 3 Complete — What Exists Now

- v3 schema: `flags` + `config` tables.
- `analytics`: currency-segmented KPIs (P&L, win rate, expectancy, avg R/MAE/MFE, equity curve) + generic `breakdown(trades, keyFn)`.
- `rule-engine`: the six mistake flags, each toggleable and threshold-tunable, all deterministic.

**The entire pure core is now done** (trade-builder, stop-inference, risk, mae-mfe, analytics, rule-engine). Next: **Plan 4** wires the real `futu-client` (replacing the spike), a single `candles` source, and the `sync` orchestrator that runs the whole pipeline against live OpenD data.
