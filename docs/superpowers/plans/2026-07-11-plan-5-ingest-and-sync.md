# Ingest & Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Wire the pure core + persistence layer to real data: map FUTU's OpenD responses into domain types, fetch candles from a single free source, and orchestrate `runSync` — pull raw → persist → rebuild derived trades/flags. Delete the throwaway spike.

**Architecture:** A thin **live** `futu-client` (WebSocket to OpenD) and a **candles** source are the only I/O. All the logic that matters — the FUTU→domain mappers and the whole sync orchestration — is pure or dependency-injected, so it is unit-tested offline against fixtures/stubs. `runSync` depends on the `FutuClient` and `CandleSource` **interfaces**, never the sockets, so the end-to-end sync test runs with in-memory stubs. The live implementations are the only untested-by-CI code (verified by a manual smoke run against OpenD, exactly as the spike was).

**Tech Stack:** Bun + TypeScript, `futu-api` (WebSocket to OpenD), `fetch` (Yahoo chart API), `bun:sqlite`, `bun test`.

**Proto facts (verified against `node_modules/futu-api/proto/Trd_Common.proto`):** field names + enum values used by the mappers are captured inline in Task 2. Response wrappers: `GetAccList → s2c.accList`, `GetHistoryOrderFillList → s2c.orderFillList`, `GetHistoryOrderList → s2c.orderList`, `GetPositionList → s2c.positionList`.

---

## File Structure

- **Create** `src/domain/ports.ts` — the `Account`, `FutuClient`, `CandleSource` interfaces (the seams sync depends on).
- **Create** `src/futu/map.ts` — **pure** FUTU-row → domain mappers + enum tables + time/symbol/currency helpers.
- **Create** `src/candles/yahoo.ts` — Yahoo symbol mapping + chart-JSON parser (pure) + `getCandles` (injectable fetch).
- **Create** `src/sync/sync.ts` — `runSync(deps)` orchestrator (pure control flow over injected ports + store).
- **Create** `src/futu/client.ts` — live `FutuClient` over `ftWebsocket` (manual-tested; delegates all shaping to `map.ts`).
- **Create** `src/sync/run.ts` — CLI entrypoint: connect live client + Yahoo candles, open the real DB, `runSync`, print a summary.
- **Delete** `src/futu/spike.ts` — superseded by `client.ts` + `run.ts`.
- **Create** tests: `test/futu/map.test.ts`, `test/candles/yahoo.test.ts`, `test/sync/sync.test.ts`.
- **Create** `test/fixtures/yahoo-aapl.json` — a captured (trimmed) Yahoo chart response.
- **Modify** `test/helpers.ts` — add builders for raw FUTU rows if useful (or inline in tests).

Domain symbols are normalized to `"<MKT>.<code>"` (e.g. `"US.AAPL"`, `"HK.00700"`) everywhere — that is what `trade-builder`/`stop-inference` compare on and what `candles` maps to a Yahoo symbol.

---

## Task 1: Ports (interfaces sync depends on)

**Files:** Create `src/domain/ports.ts`.

- [ ] **Step 1: Write the interfaces** (no test — pure type declarations; the compiler is the test)

```ts
import type { Candle, RawFill, RawOrder, RawPosition } from "./types";

/** A trading account as surfaced by OpenD (Trd_GetAccList). */
export interface Account {
  id: string; // accID (uint64) as a string
  trdEnv: number; // 0 = simulate, 1 = real
  markets: number[]; // trdMarketAuthList (TrdMarket enum values)
}

/** Read-only access to OpenD. Times are epoch ms; the live impl formats them to FUTU strings. */
export interface FutuClient {
  getAccounts(): Promise<Account[]>;
  getHistoryFills(account: Account, market: number, beginMs: number, endMs: number): Promise<RawFill[]>;
  getHistoryOrders(account: Account, market: number, beginMs: number, endMs: number): Promise<RawOrder[]>;
  getPositions(account: Account, market: number): Promise<RawPosition[]>;
  close(): void;
}

/** OHLC source for MAE/MFE + charts. `resMs` is the bar duration in ms. */
export interface CandleSource {
  getCandles(symbol: string, fromMs: number, toMs: number, resMs: number): Promise<Candle[]>;
}
```

- [ ] **Step 2: Typecheck + commit**

Run: `bunx tsc --noEmit` → clean.
```bash
git add src/domain/ports.ts
git commit -m "feat(domain): FutuClient/CandleSource/Account ports"
```

---

## Task 2: FUTU → domain mappers (pure)

**Files:** Create `src/futu/map.ts`, `test/futu/map.test.ts`.

The mappers convert already-decoded FUTU objects (the SDK returns plain JS, not protobuf buffers) into domain rows. Enum/field facts below are from the proto.

**Enums used:**
- `TrdSide`: 1=Buy, 2=Sell, 3=SellShort, 4=BuyBack → domain `"BUY"|"SELL"` (Buy/BuyBack→BUY; Sell/SellShort→SELL).
- `OrderType`: 1=Normal & 5–9 limit variants→`"LIMIT"`; 2=Market→`"MARKET"`; 10=Stop→`"STOP"`; 11=StopLimit→`"STOP_LIMIT"`; 14=TrailingStop & 15=TrailingStopLimit→`"TRAILING_STOP"`; everything else (12/13 touched, 16–19 TWAP/VWAP, 0 unknown)→`"OTHER"`.
- `TrdMarket`: 1=HK, 2=US, 3=CN, 4=HKCC, 6=SG, 8=AU, 15=JP, 111=MY, 112=CA → symbol prefix `HK/US/CN/HK/SG/AU/JP/MY/CA`; currency `HKD/USD/CNH/HKD/SGD/AUD/JPY/MYR/CAD`.
- `Currency` (Order/Position carry it directly): 1=HKD,2=USD,3=CNH,4=JPY,5=SGD,6=AUD,7=CAD,8=MYR.
- `PositionSide`: 0=Long, 1=Short → signed qty (`Short → -qty`).
- `OrderStatus` → canonical UPPER_SNAKE name so `stop-inference`'s dead-status substring match works (3=SUBMIT_FAILED, 4=TIMEOUT, 21=FAILED, 22=DISABLED, 23=DELETED map to strings containing FAIL/TIMEOUT/DISABLED/DELETED; 5=SUBMITTED, 11=FILLED_ALL, 15=CANCELLED_ALL, etc.).

**Field facts:** `OrderFill{trdSide, fillID, orderID, code, qty, price, createTimestamp, updateTimestamp, trdMarket, secMarket}` — **no fee, no currency** (derive currency from market; fee=0, see below). `Order{trdSide, orderType, orderStatus, orderID, code, qty, price, auxPrice(trigger), createTimestamp, updateTimestamp, trdMarket, secMarket, currency}`. `Position{positionSide, code, qty, averageCostPrice|dilutedCostPrice|costPrice, currency, trdMarket, accID}`. `TrdAcc{accID, trdEnv, trdMarketAuthList}`.

**Timestamps:** FUTU `*Timestamp` fields are unix **seconds** (double). Convert `Math.round(ts*1000)`. Fall back to parsing the `createTime`/`updateTime` string (`"YYYY-MM-DD HH:MM:SS[.ms]"`) only if the numeric timestamp is absent.

**Fee (v1 limitation):** historical fills carry no fee; set `fee = 0`. `realizedPnl` is therefore gross of commissions in v1. A later plan can enrich via `Trd_GetOrderFee`. Document this in the file header.

- [ ] **Step 1: Write failing tests** — `test/futu/map.test.ts`:

```ts
import { test, expect } from "bun:test";
import { mapFill, mapOrder, mapPosition, mapAccount, currencyForMarket, futuSymbol } from "../../src/futu/map";

test("futuSymbol / currencyForMarket normalize by market", () => {
  expect(futuSymbol("AAPL", 2)).toBe("US.AAPL");
  expect(futuSymbol("00700", 1)).toBe("HK.00700");
  expect(currencyForMarket(2)).toBe("USD");
  expect(currencyForMarket(1)).toBe("HKD");
});

test("mapFill maps a US buy fill (fee defaults to 0, currency from market, ms from timestamp)", () => {
  const f = mapFill({
    trdSide: 1, fillID: 123, orderID: 456, code: "AAPL", qty: 100, price: 10.5,
    createTimestamp: 1_700_000_000, trdMarket: 2,
  }, "acc1");
  expect(f).toEqual({
    id: "123", orderId: "456", symbol: "US.AAPL", side: "BUY", qty: 100, price: 10.5,
    fee: 0, currency: "USD", time: 1_700_000_000_000, account: "acc1",
  });
});

test("mapFill treats SellShort as SELL", () => {
  expect(mapFill({ trdSide: 3, fillID: 1, orderID: 1, code: "X", qty: 1, price: 1, createTimestamp: 1, trdMarket: 2 }, "a").side).toBe("SELL");
});

test("mapOrder maps a stop order: trigger from auxPrice, type STOP, dead status name", () => {
  const o = mapOrder({
    trdSide: 2, orderType: 10, orderStatus: 15, orderID: 9, code: "AAPL", qty: 100,
    price: 0, auxPrice: 9.5, createTimestamp: 100, updateTimestamp: 200, trdMarket: 2,
  }, "acc1");
  expect(o.type).toBe("STOP");
  expect(o.triggerPrice).toBe(9.5);
  expect(o.price).toBeNull(); // stop-market has no limit price
  expect(o.status).toBe("CANCELLED_ALL");
  expect(o.createTime).toBe(100_000);
  expect(o.updateTime).toBe(200_000);
  expect(o.symbol).toBe("US.AAPL");
});

test("mapOrder maps a plain limit: type LIMIT, price kept, trigger null", () => {
  const o = mapOrder({ trdSide: 1, orderType: 1, orderStatus: 11, orderID: 1, code: "00700", qty: 10, price: 350, createTimestamp: 1, trdMarket: 1 }, "a");
  expect(o.type).toBe("LIMIT");
  expect(o.price).toBe(350);
  expect(o.triggerPrice).toBeNull();
  expect(o.status).toBe("FILLED_ALL");
});

test("mapPosition signs qty by side and picks averageCostPrice", () => {
  const long = mapPosition({ positionSide: 0, code: "AAPL", qty: 100, averageCostPrice: 10, currency: 2, trdMarket: 2 }, "acc1", 5000);
  expect(long).toEqual({ account: "acc1", symbol: "US.AAPL", qty: 100, avgCost: 10, currency: "USD", time: 5000 });
  const short = mapPosition({ positionSide: 1, code: "TSLA", qty: 50, averageCostPrice: 200, currency: 2, trdMarket: 2 }, "acc1", 5000);
  expect(short.qty).toBe(-50);
});

test("mapPosition falls back dilutedCostPrice → costPrice when averageCostPrice missing", () => {
  expect(mapPosition({ positionSide: 0, code: "X", qty: 1, dilutedCostPrice: 7, currency: 2, trdMarket: 2 }, "a", 1).avgCost).toBe(7);
  expect(mapPosition({ positionSide: 0, code: "X", qty: 1, costPrice: 3, currency: 2, trdMarket: 2 }, "a", 1).avgCost).toBe(3);
});

test("mapAccount surfaces id/env/markets", () => {
  expect(mapAccount({ accID: 42, trdEnv: 1, trdMarketAuthList: [1, 2] })).toEqual({ id: "42", trdEnv: 1, markets: [1, 2] });
});

test("timestamp falls back to parsing the string form when numeric ts is absent", () => {
  const f = mapFill({ trdSide: 1, fillID: 1, orderID: 1, code: "AAPL", qty: 1, price: 1, createTime: "2023-11-14 22:13:20", trdMarket: 2 }, "a");
  expect(typeof f.time).toBe("number");
  expect(f.time).toBeGreaterThan(1_600_000_000_000);
});
```

- [ ] **Step 2:** Run → FAIL (module missing).

- [ ] **Step 3: Implement `src/futu/map.ts`.** Header comment must note the fee=0 v1 limitation. Provide:
  - `futuSymbol(code, market)`, `currencyForMarket(market)`, `currencyForEnum(cur)`, `toMs(timestamp?, timeStr?)`, `sideFrom(trdSide)`, `orderTypeFrom(orderType)`, `orderStatusName(orderStatus)`.
  - `mapFill(raw, account)`, `mapOrder(raw, account)`, `mapPosition(raw, account, snapshotMs)`, `mapAccount(raw)`.
  - `orderTypeFrom` returns a tuple or infers trigger: set `triggerPrice = STOP_TYPES.has(type) ? (auxPrice ?? null) : null`; `price = type === "MARKET" || type === "STOP" ? null : (raw.price ?? null)` (stop-market/market have no limit price; stop-limit keeps `price`). Keep it explicit and readable.
  - `toMs`: `if (typeof timestamp === "number") return Math.round(timestamp * 1000); return Date.parse(timeStr.replace(" ", "T"))` (accepting local-tz parse for the string fallback — numeric path is the norm).

- [ ] **Step 4:** Run → PASS. **Step 5:** Commit `feat(futu): pure FUTU→domain mappers`.

---

## Task 3: Candles (Yahoo source)

**Files:** Create `src/candles/yahoo.ts`, `test/candles/yahoo.test.ts`, `test/fixtures/yahoo-aapl.json`.

Yahoo chart endpoint: `https://query1.finance.yahoo.com/v8/finance/chart/<sym>?period1=<s>&period2=<s>&interval=<i>` (period in **seconds**). Response: `chart.result[0].timestamp[]` (unix **seconds**) + `chart.result[0].indicators.quote[0].{open,high,low,close,volume}[]`. Null entries appear for gaps and must be skipped.

Symbol mapping (domain `"<MKT>.<code>"` → Yahoo): `US.AAPL → AAPL`; `HK.00700 → 0700.HK` (HK: strip to 4 digits, drop a leading zero from the 5-digit FUTU code, append `.HK`); `CN.600000 → 600000.SS`/`.SZ` is out of v1 scope — map US + HK, throw a clear error for unsupported markets. Interval from `resMs`: `86_400_000→"1d"`, `3_600_000→"1h"`, `60_000→"1m"`.

- [ ] **Step 1: Capture a fixture** — `test/fixtures/yahoo-aapl.json`: a trimmed real-shape response with ~3 timestamps, one containing a `null` close (to test gap-skipping). Hand-author it to the shape above (no network in tests).

- [ ] **Step 2: Write failing tests** — `test/candles/yahoo.test.ts`:

```ts
import { test, expect } from "bun:test";
import { yahooSymbol, intervalFor, parseChart, getCandles } from "../../src/candles/yahoo";
import fixture from "../fixtures/yahoo-aapl.json";

test("yahooSymbol maps US and HK", () => {
  expect(yahooSymbol("US.AAPL")).toBe("AAPL");
  expect(yahooSymbol("HK.00700")).toBe("0700.HK");
});

test("yahooSymbol throws on unsupported market", () => {
  expect(() => yahooSymbol("CN.600000")).toThrow();
});

test("intervalFor maps resolution ms", () => {
  expect(intervalFor(86_400_000)).toBe("1d");
  expect(intervalFor(3_600_000)).toBe("1h");
});

test("parseChart yields OHLCV in ms, skipping null gaps", () => {
  const candles = parseChart(fixture);
  expect(candles.length).toBeGreaterThan(0);
  expect(candles[0]!.time % 1000).toBe(0); // ms
  for (const c of candles) {
    expect(c.close).not.toBeNull();
    expect(c.high).toBeGreaterThanOrEqual(c.low);
  }
});

test("getCandles builds the URL, uses injected fetch, returns parsed candles", async () => {
  let calledUrl = "";
  const fakeFetch = async (url: string) => {
    calledUrl = url;
    return { ok: true, json: async () => fixture } as Response;
  };
  const out = await getCandles("US.AAPL", 1_700_000_000_000, 1_700_200_000_000, 86_400_000, fakeFetch as any);
  expect(calledUrl).toContain("/v8/finance/chart/AAPL");
  expect(calledUrl).toContain("interval=1d");
  expect(calledUrl).toContain("period1=1700000000"); // seconds, not ms
  expect(out.length).toBe(parseChart(fixture).length);
});

test("getCandles returns [] on a non-ok response (chart falls back gracefully)", async () => {
  const fakeFetch = async () => ({ ok: false, status: 404 } as Response);
  expect(await getCandles("US.AAPL", 1, 2, 86_400_000, fakeFetch as any)).toEqual([]);
});
```

- [ ] **Step 3: Implement `src/candles/yahoo.ts`** implementing `CandleSource` via a `getCandles` free function (period1/period2 = `Math.floor(ms/1000)`). Non-ok or malformed → return `[]` (candle failure must never break sync — spec §12). Export `yahooSymbol`, `intervalFor`, `parseChart`, `getCandles`, and a `yahooCandles: CandleSource` object wrapping `getCandles` with the global `fetch`.

- [ ] **Step 4:** Run → PASS. **Step 5:** Commit `feat(candles): Yahoo chart source (injectable fetch)`.

---

## Task 4: Sync orchestrator

**Files:** Create `src/sync/sync.ts`, `test/sync/sync.test.ts`.

`runSync(deps)` where `deps = { db, client: FutuClient, candles: CandleSource, config: RuleConfig, now: number, historyDays?: number }`. `now` (epoch ms) is injected so tests are deterministic. Flow:

1. `accounts = await client.getAccounts()`.
2. For each account, for each `market` in `account.markets`: read `sync_state`; `beginMs = state?.lastSyncedTime ?? now - historyDays*86_400_000` (default 90); `endMs = now`. Pull fills + orders (paced — one `await` at a time is fine for v1; no parallel burst). `upsertRawFills` / `upsertRawOrders`. Pull positions; collect into a per-account snapshot list. `upsertSyncState({ account: id, market, lastSyncedTime: now, coverageStart: state?.coverageStart ?? beginMs })`.
3. After all markets for an account: `insertPositionSnapshot(db, snapshotRows)` **once** with `time = now` (a single coherent batch — even if empty, `positionsAt(db, now)` then correctly reflects a flat account).
4. **Rebuild derived** from the full raw set: `trades = buildTrades(allRawFills(db))` (v1 passes no seeds — pre-existing-position seeding is a documented later refinement). Sort trades by `openTime`. For each trade:
   - `symbolOrders = allRawOrders(db).filter(o => o.account === t.account && o.symbol === t.symbol)`.
   - `stop = inferStops(t, symbolOrders)`; `{ risk, rMultiple } = computeRisk(t, stop.initialStop)` (initial = planned risk, spec §6).
   - `{ interval, resMs } = pickResolution(t)`; `candles = await candles.getCandles(t.symbol, t.openTime - pad, (t.closeTime ?? now) + pad, resMs)`; `{ mae, mfe } = computeExcursion(t, candles, resMs)`.
   - `enriched = { ...t, effectiveStop: stop.effectiveStop, effectiveTp: stop.effectiveTp, risk, rMultiple, mae, mfe }`.
   - `fills = tradeFills(allFills, t)`; `recent = recentClosedTrades(enrichedSoFar, t)`; `flags = evaluate(enriched, { fills, recentClosedTrades: recent }, config)`.
   - accumulate `enriched` + `flags`.
5. `replaceDerived(db, enrichedTrades, flagMap)`.
6. Return `{ accounts: n, fills: n, orders: n, trades: n, flags: n }`.

Helpers (pure, in this file): `pickResolution(t)` → `{ interval: "1d"|"1h", resMs }` (`holdSeconds != null && holdSeconds < 2*86400 ? 1h : 1d`; open trades → 1d); `recentClosedTrades(prior, t)` → prior trades that are `closed && coverageOk && closeTime !== null && closeTime <= t.openTime && account === t.account`.

- [ ] **Step 1: Write the end-to-end test with stubs** — `test/sync/sync.test.ts`:

```ts
import { test, expect } from "bun:test";
import { openTestDb } from "../helpers";
import { runSync } from "../../src/sync/sync";
import { DEFAULT_RULE_CONFIG, type Candle } from "../../src/domain/types";
import type { Account, CandleSource, FutuClient } from "../../src/domain/ports";
import { allTrades, flagsForTrade } from "../../src/store/repos";
import { getSyncState } from "../../src/store/sync-state";

const ACC: Account = { id: "acc1", trdEnv: 1, markets: [2] };

function stubClient(over: Partial<FutuClient> = {}): FutuClient {
  return {
    getAccounts: async () => [ACC],
    getHistoryFills: async () => [],
    getHistoryOrders: async () => [],
    getPositions: async () => [],
    close: () => {},
    ...over,
  };
}
const noCandles: CandleSource = { getCandles: async () => [] };

test("runSync pulls fills, rebuilds a closed round-trip trade, persists it", async () => {
  const db = openTestDb();
  const client = stubClient({
    getHistoryFills: async () => [
      { id: "f1", orderId: "o1", symbol: "US.AAPL", side: "BUY", qty: 100, price: 10, fee: 0, currency: "USD", time: 1000, account: "acc1" },
      { id: "f2", orderId: "o2", symbol: "US.AAPL", side: "SELL", qty: 100, price: 12, fee: 0, currency: "USD", time: 2000, account: "acc1" },
    ],
  });
  const res = await runSync({ db, client, candles: noCandles, config: DEFAULT_RULE_CONFIG, now: 10_000 });
  expect(res.trades).toBe(1);
  const t = allTrades(db)[0]!;
  expect(t.status).toBe("closed");
  expect(t.realizedPnl).toBe(200);
  const s = getSyncState(db, "acc1", "US")!; // market 2 → "US"
  expect(s.lastSyncedTime).toBe(10_000);
});

test("runSync enriches stop/risk from orders and MAE/MFE from candles", async () => {
  const db = openTestDb();
  const client = stubClient({
    getHistoryFills: async () => [
      { id: "f1", orderId: "o1", symbol: "US.AAPL", side: "BUY", qty: 100, price: 10, fee: 0, currency: "USD", time: 1000, account: "acc1" },
      { id: "f2", orderId: "o2", symbol: "US.AAPL", side: "SELL", qty: 100, price: 11, fee: 0, currency: "USD", time: 5000, account: "acc1" },
    ],
    getHistoryOrders: async () => [
      { id: "s1", symbol: "US.AAPL", side: "SELL", type: "STOP", qty: 100, price: null, triggerPrice: 9, status: "SUBMITTED", createTime: 1500, updateTime: null, account: "acc1" },
    ],
  });
  const candles: CandleSource = {
    getCandles: async (): Promise<Candle[]> => [
      { time: 1000, open: 10, high: 13, low: 8, close: 11, volume: 1 }, // high 13 → mfe 3; low 8 → mae 2
    ],
  };
  await runSync({ db, client, candles, config: DEFAULT_RULE_CONFIG, now: 10_000 });
  const t = allTrades(db)[0]!;
  expect(t.effectiveStop).toBe(9);
  expect(t.risk).toBe(100); // |10-9| * 100
  expect(t.rMultiple).toBeCloseTo(1, 5); // pnl 100 / risk 100
  expect(t.mae).toBe(2);
  expect(t.mfe).toBe(3);
});

test("runSync fires a mistake flag through the full pipeline", async () => {
  const db = openTestDb();
  // A winner cut for < 1R (risk 100, exit +40 → 0.4R) → cut_winner_early.
  const client = stubClient({
    getHistoryFills: async () => [
      { id: "f1", orderId: "o1", symbol: "US.AAPL", side: "BUY", qty: 100, price: 10, fee: 0, currency: "USD", time: 1000, account: "acc1" },
      { id: "f2", orderId: "o2", symbol: "US.AAPL", side: "SELL", qty: 100, price: 10.4, fee: 0, currency: "USD", time: 5000, account: "acc1" },
    ],
    getHistoryOrders: async () => [
      { id: "s1", symbol: "US.AAPL", side: "SELL", type: "STOP", qty: 100, price: null, triggerPrice: 9, status: "SUBMITTED", createTime: 1500, updateTime: null, account: "acc1" },
    ],
  });
  await runSync({ db, client, candles: noCandles, config: DEFAULT_RULE_CONFIG, now: 10_000 });
  const t = allTrades(db)[0]!;
  expect(flagsForTrade(db, t.id).map((f) => f.ruleId)).toContain("cut_winner_early");
});

test("runSync writes an empty position snapshot for a flat account (no phantom holdings)", async () => {
  const db = openTestDb();
  await runSync({ db, client: stubClient(), candles: noCandles, config: DEFAULT_RULE_CONFIG, now: 10_000 });
  // getPositions returns [] → snapshot at now is empty → positionsAt(now) is [].
  const { positionsAt } = await import("../../src/store/repos");
  expect(positionsAt(db, 10_000)).toEqual([]);
});

test("runSync is incremental — second run pulls from the last cursor", async () => {
  const db = openTestDb();
  const seen: number[] = [];
  const client = stubClient({ getHistoryFills: async (_a, _m, begin) => { seen.push(begin); return []; } });
  await runSync({ db, client, candles: noCandles, config: DEFAULT_RULE_CONFIG, now: 100_000, historyDays: 1 });
  await runSync({ db, client, candles: noCandles, config: DEFAULT_RULE_CONFIG, now: 200_000, historyDays: 1 });
  expect(seen[0]).toBe(100_000 - 86_400_000); // first: now - 1 day
  expect(seen[1]).toBe(100_000); // second: last cursor
});
```

- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement `src/sync/sync.ts` per the flow above. Market-number → market-name for `sync_state` uses a small map (2→"US", 1→"HK", …) shared with `map.ts` (export `marketName(market)` from `map.ts`). **Step 4:** Run → PASS. **Step 5:** `bun test && bunx tsc --noEmit`. **Step 6:** Commit `feat(sync): runSync orchestrator (offline-tested with stubs)`.

---

## Task 5: Live FUTU client + CLI, delete spike

**Files:** Create `src/futu/client.ts`, `src/sync/run.ts`; delete `src/futu/spike.ts`. (No CI test — manual smoke against OpenD, like the spike.)

- [ ] **Step 1: `src/futu/client.ts`** — a `connectFutu({ host, port, key }): Promise<FutuClient>` that wraps `ftWebsocket` (default import), resolves on `onlogin(true)`, and implements the four `FutuClient` methods by calling `GetAccList` / `GetHistoryOrderFillList` / `GetHistoryOrderList` / `GetPositionList` and mapping each response array through `map.ts` (`mapAccount`/`mapFill`/`mapOrder`/`mapPosition`). Format `beginMs`/`endMs` to FUTU `"YYYY-MM-DD HH:MM:SS"` strings **here** (reuse the spike's local-time formatter). Pace history calls: `await` sequentially and add a small delay (e.g. 350 ms) between history requests to respect FUTU's window/rate limits. `close()` calls `ws.stop()`. Read `map.ts` `TRD_ENV_REAL`/header shape from the spike for the request envelopes.

- [ ] **Step 2: `src/sync/run.ts`** — read `OPEND_WS_KEY` / `OPEND_PORT` (defaults 33334) from env and the DB path from `dbPath()`; `openDb` + `runMigrations` + `backupDb` first; `connectFutu` + `yahooCandles`; `getRuleConfig(db)`; `runSync({ db, client, candles, config, now: Date.now() })`; print the summary; `client.close()`. This is the real-data entrypoint that replaces the spike's role.

- [ ] **Step 3: Delete the spike.** `git rm src/futu/spike.ts`. Confirm nothing imports it: `grep -rn "futu/spike" src test` → empty.

- [ ] **Step 4: Typecheck + full suite.** `bunx tsc --noEmit` clean; `bun test` green (live files aren't imported by tests).

- [ ] **Step 5: Manual smoke (requires the user's OpenD running).** With OpenD up + websocket_port + auth key set: `OPEND_WS_KEY=<key> bun run src/sync/run.ts` → expect it to connect, pull, and print a non-error summary; the DB gains real `trades`/`flags`. **This is the one step CI cannot cover.** If OpenD isn't available at execution time, land the PR with the offline suite green and note the smoke test as pending for the user to run.

- [ ] **Step 6: Commit** `feat(futu): live OpenD client + sync CLI; remove spike`.

---

## Done criteria

- `bun test` green; `bunx tsc --noEmit` clean.
- The whole ingest→persist→rebuild pipeline runs offline in `test/sync/sync.test.ts` against stub client/candles.
- Live `futu-client` + `run.ts` exist; `spike.ts` is gone.
- Candle failure degrades gracefully (`[]`), never breaks sync.
- **Manual:** one live smoke run against OpenD confirms real data flows end-to-end (may be deferred to the user if OpenD isn't up during execution).

## Review-driven changes (Codex + Fable)

Landed during review, beyond the task steps above:
- **Real accounts + known markets only:** `runSync` filters `trdEnv === TRD_ENV_REAL` (FUTU returns sim accounts too, whose history endpoints reject → would abort the sync) and skips unrecognized markets (futures/funds). *(Fable #1)*
- **Unique sync cursor keys:** `marketName` has its own map so HK(1)/HKCC(4) don't collide on the `sync_state` key. *(Codex P1)*
- **protobufjs zero-defaults:** omitted optional numerics decode as `0`, not `undefined`. `marketOf`/`||` fallbacks for market+cost, and `auxPrice > 0 ? … : null` / `price > 0 ? … : null` so a trailing stop with an omitted trigger isn't read as a live "stop @ 0". *(Codex P2, Fable #2)*
- **Orders pulled over the full window:** orders mutate after creation and FUTU filters history orders by create time, so an incremental window would never refetch a moved stop. Fills stay incremental; orders always pull `historyDays`. *(Fable #3)*
- **MAE/MFE carry-forward (shape-guarded):** a candle-source outage returns `[]`; rather than overwrite prior excursions (and their flags) with null, sync carries forward the previous trade's mae/mfe — but only when the trade's window/shape (closeTime, avgEntry, maxQty) is unchanged, so a trade that gained fills doesn't reuse a stale window's excursion. A candle-source *rejection* is caught per-trade and degraded to `[]`. *(Fable #4, Codex P2)*
- **Dotted tickers + HKCC currency:** `yahooSymbol` splits on the first dot and maps `US.BRK.B → BRK-B`; HKCC settles in CNH. *(Codex P2, Fable minor)*
- **Cancelled fills dropped:** `getHistoryFills` filters `OrderFillStatus_Cancelled` so a never-executed fill can't corrupt positions/P&L. *(Codex P2)*
- **Live-client lifecycle:** `connectFutu` fails fast (10s timeout + onerror/onclose reject) instead of hanging if OpenD is down; `close()` reaches `ws.websock.close()` (the real socket + reconnect timer). *(Codex P2/P3)*
- **Pre-existing-position seeding (money-math P1):** `deriveSeeds` reconstructs the pre-window position per (account, symbol) as `currentSnapshotQty − Σ(all stored fills)`. A non-zero result seeds `buildTrades`, so a holding opened before coverage and sold inside it builds as `coverageOk:false` (excluded from P&L/stats) instead of a phantom opposite-direction trade with wrong P&L. *(Codex P1, Fable #5)*

**Remaining follow-ups (tracked as a task):** incremental resync reconciliation — deleting fills FUTU later cancels after they were stored, refetching orders whose stop moved outside the create-time window, and a candle cache (spec §8 `candles_cache`) to stop re-fetching every sync. The MAE/MFE carry-forward already removes the candle-outage data-loss risk in the meantime.

**Next (Plan 6 — API + web):** a Bun HTTP server over the store/analytics + a React/Vite SPA (Lightweight Charts) — dashboard, trades, detail, open positions, weekly journal.
