import { test, expect } from "bun:test";
import { openTestDb } from "../helpers";
import { runSync } from "../../src/sync/sync";
import { DEFAULT_RULE_CONFIG, type Candle } from "../../src/domain/types";
import type { Account, CandleSource, FutuClient } from "../../src/domain/ports";
import { allTrades, flagsForTrade, positionsAt } from "../../src/store/repos";
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
  expect(res.fills).toBe(2);
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
  expect(positionsAt(db, 10_000)).toEqual([]);
});

test("runSync snapshots current positions at the sync clock", async () => {
  const db = openTestDb();
  const client = stubClient({
    getPositions: async () => [
      { account: "acc1", symbol: "US.AAPL", qty: 100, avgCost: 10, currency: "USD", time: 0 },
    ],
  });
  await runSync({ db, client, candles: noCandles, config: DEFAULT_RULE_CONFIG, now: 10_000 });
  const held = positionsAt(db, 10_000);
  expect(held).toEqual([{ account: "acc1", symbol: "US.AAPL", qty: 100, avgCost: 10, currency: "USD", time: 10_000 }]);
});

test("runSync is incremental — second run pulls from the last cursor", async () => {
  const db = openTestDb();
  const seen: number[] = [];
  const client = stubClient({
    getHistoryFills: async (_a, _m, begin) => {
      seen.push(begin);
      return [];
    },
  });
  await runSync({ db, client, candles: noCandles, config: DEFAULT_RULE_CONFIG, now: 100_000, historyDays: 1 });
  await runSync({ db, client, candles: noCandles, config: DEFAULT_RULE_CONFIG, now: 200_000, historyDays: 1 });
  expect(seen[0]).toBe(100_000 - 86_400_000); // first: now - 1 day
  expect(seen[1]).toBe(100_000); // second: last cursor
});

test("runSync skips simulate accounts (only trdEnv real is queried)", async () => {
  const db = openTestDb();
  const queried: string[] = [];
  const client: FutuClient = {
    getAccounts: async () => [
      { id: "real", trdEnv: 1, markets: [2] },
      { id: "sim", trdEnv: 0, markets: [2] },
    ],
    getHistoryFills: async (a) => {
      queried.push(a.id);
      return [];
    },
    getHistoryOrders: async () => [],
    getPositions: async () => [],
    close: () => {},
  };
  const res = await runSync({ db, client, candles: noCandles, config: DEFAULT_RULE_CONFIG, now: 10_000 });
  expect(res.accounts).toBe(1);
  expect(queried).toEqual(["real"]); // sim account never queried
});

test("runSync skips unknown markets (e.g. futures=5)", async () => {
  const db = openTestDb();
  const markets: number[] = [];
  const client = stubClient({
    getAccounts: async () => [{ id: "acc1", trdEnv: 1, markets: [2, 5] }], // US + futures
    getHistoryFills: async (_a, m) => {
      markets.push(m);
      return [];
    },
  });
  await runSync({ db, client, candles: noCandles, config: DEFAULT_RULE_CONFIG, now: 10_000 });
  expect(markets).toEqual([2]); // futures (5) skipped
});

test("runSync pulls orders over the full window even on incremental fill syncs", async () => {
  const db = openTestDb();
  const orderBegins: number[] = [];
  const client = stubClient({
    getHistoryOrders: async (_a, _m, begin) => {
      orderBegins.push(begin);
      return [];
    },
  });
  await runSync({ db, client, candles: noCandles, config: DEFAULT_RULE_CONFIG, now: 100_000, historyDays: 1 });
  await runSync({ db, client, candles: noCandles, config: DEFAULT_RULE_CONFIG, now: 200_000, historyDays: 1 });
  // Both runs pull orders from now - historyDays (mutable orders), NOT from the fills cursor.
  expect(orderBegins[0]).toBe(100_000 - 86_400_000);
  expect(orderBegins[1]).toBe(200_000 - 86_400_000);
});

test("runSync carries forward MAE/MFE when candles degrade (no silent regression)", async () => {
  const db = openTestDb();
  const fills = [
    { id: "f1", orderId: "o1", symbol: "US.AAPL", side: "BUY" as const, qty: 100, price: 10, fee: 0, currency: "USD", time: 1000, account: "acc1" },
    { id: "f2", orderId: "o2", symbol: "US.AAPL", side: "SELL" as const, qty: 100, price: 11, fee: 0, currency: "USD", time: 5000, account: "acc1" },
  ];
  const client = stubClient({ getHistoryFills: async () => fills });
  const withCandles: CandleSource = {
    getCandles: async () => [{ time: 1000, open: 10, high: 13, low: 8, close: 11, volume: 1 }],
  };
  await runSync({ db, client, candles: withCandles, config: DEFAULT_RULE_CONFIG, now: 10_000 });
  expect(allTrades(db)[0]!.mae).toBe(2);

  // Second sync during a Yahoo outage (getCandles → []): prior mae/mfe must survive, not go null.
  await runSync({ db, client, candles: noCandles, config: DEFAULT_RULE_CONFIG, now: 20_000 });
  const t = allTrades(db)[0]!;
  expect(t.mae).toBe(2);
  expect(t.mfe).toBe(3);
});

test("runSync is idempotent — re-running the same data yields the same single trade", async () => {
  const db = openTestDb();
  const client = stubClient({
    getHistoryFills: async () => [
      { id: "f1", orderId: "o1", symbol: "US.AAPL", side: "BUY", qty: 100, price: 10, fee: 0, currency: "USD", time: 1000, account: "acc1" },
      { id: "f2", orderId: "o2", symbol: "US.AAPL", side: "SELL", qty: 100, price: 12, fee: 0, currency: "USD", time: 2000, account: "acc1" },
    ],
  });
  await runSync({ db, client, candles: noCandles, config: DEFAULT_RULE_CONFIG, now: 10_000 });
  await runSync({ db, client, candles: noCandles, config: DEFAULT_RULE_CONFIG, now: 20_000 });
  expect(allTrades(db)).toHaveLength(1); // upserts dedupe raw; derived fully replaced
});
