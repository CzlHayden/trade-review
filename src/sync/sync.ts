import type { Database } from "bun:sqlite";
import type { CandleSource, FutuClient } from "../domain/ports";
import type { Flag, RawPosition, RuleConfig, Trade } from "../domain/types";
import { buildTrades } from "../core/trade-builder";
import { inferStops } from "../core/stop-inference";
import { computeRisk } from "../core/risk";
import { computeExcursion } from "../core/mae-mfe";
import { evaluate } from "../core/rule-engine";
import { marketName } from "../futu/map";
import {
  allRawFills,
  allRawOrders,
  insertPositionSnapshot,
  replaceDerived,
  upsertRawFills,
  upsertRawOrders,
} from "../store/repos";
import { getSyncState, upsertSyncState } from "../store/sync-state";

const DAY_MS = 86_400_000;
const PAD_MS = 2 * DAY_MS; // context padding around the trade window for candles

export interface SyncDeps {
  db: Database;
  client: FutuClient;
  candles: CandleSource;
  config: RuleConfig;
  now: number; // injected epoch ms (deterministic in tests)
  historyDays?: number; // first-sync lookback window (default 90)
}

export interface SyncResult {
  accounts: number;
  fills: number;
  orders: number;
  trades: number;
  flags: number;
}

/** Daily bars for swing trades; hourly for intraday (held < 2 days). Open trades → daily. */
function resolutionMs(t: Trade): number {
  const intraday = t.holdSeconds !== null && t.holdSeconds < 2 * (DAY_MS / 1000);
  return intraday ? 3_600_000 : DAY_MS;
}

/** Prior closed, coverage-ok trades in the same account that closed no later than this one opened. */
function recentClosedTrades(prior: Trade[], t: Trade): Trade[] {
  return prior.filter(
    (p) =>
      p.account === t.account &&
      p.status === "closed" &&
      p.coverageOk &&
      p.closeTime !== null &&
      p.closeTime <= t.openTime,
  );
}

/**
 * Pull raw data from OpenD, persist it, then rebuild all derived trades/flags from the full raw
 * set. Idempotent: raw upserts are keyed, derived data is fully replaced. Candle-fetch failure
 * degrades to no MAE/MFE (never breaks the sync).
 */
export async function runSync(deps: SyncDeps): Promise<SyncResult> {
  const { db, client, candles, config, now } = deps;
  const historyDays = deps.historyDays ?? 90;

  const accounts = await client.getAccounts();
  let fillCount = 0;
  let orderCount = 0;

  for (const acc of accounts) {
    const snapshot: RawPosition[] = [];
    for (const market of acc.markets) {
      const mkt = marketName(market);
      const state = getSyncState(db, acc.id, mkt);
      const beginMs = state?.lastSyncedTime ?? now - historyDays * DAY_MS;
      const endMs = now;

      const fills = await client.getHistoryFills(acc, market, beginMs, endMs);
      if (fills.length) upsertRawFills(db, fills);
      fillCount += fills.length;

      const orders = await client.getHistoryOrders(acc, market, beginMs, endMs);
      if (orders.length) upsertRawOrders(db, orders);
      orderCount += orders.length;

      const positions = await client.getPositions(acc, market);
      for (const p of positions) snapshot.push({ ...p, time: now }); // stamp one coherent batch time

      upsertSyncState(db, {
        account: acc.id,
        market: mkt,
        lastSyncedTime: now,
        coverageStart: state?.coverageStart ?? beginMs,
      });
    }
    // One snapshot batch per account at `now`. Empty batch ⇒ flat account (positionsAt(now) === []).
    insertPositionSnapshot(db, snapshot);
  }

  // ---- rebuild derived from the full raw set ----
  const allFills = allRawFills(db);
  const allOrders = allRawOrders(db);
  const built = buildTrades(allFills).sort(
    (a, b) => a.openTime - b.openTime || a.id.localeCompare(b.id),
  );

  const enrichedTrades: Trade[] = [];
  const flagMap = new Map<string, Flag[]>();

  for (const t of built) {
    const symbolOrders = allOrders.filter((o) => o.account === t.account && o.symbol === t.symbol);
    const stop = inferStops(t, symbolOrders);
    const { risk, rMultiple } = computeRisk(t, stop.initialStop); // initial = planned risk (spec §6)

    const resMs = resolutionMs(t);
    const from = t.openTime - PAD_MS;
    const to = (t.closeTime ?? now) + PAD_MS;
    const bars = await candles.getCandles(t.symbol, from, to, resMs);
    const { mae, mfe } = computeExcursion(t, bars, resMs);

    const enriched: Trade = {
      ...t,
      effectiveStop: stop.effectiveStop,
      effectiveTp: stop.effectiveTp,
      risk,
      rMultiple,
      mae,
      mfe,
    };

    const fills = allFills.filter((f) => t.fillIds.includes(f.id));
    const recent = recentClosedTrades(enrichedTrades, enriched);
    const flags = evaluate(enriched, { fills, recentClosedTrades: recent }, config);

    enrichedTrades.push(enriched);
    if (flags.length) flagMap.set(enriched.id, flags);
  }

  replaceDerived(db, enrichedTrades, flagMap);

  let flagCount = 0;
  for (const f of flagMap.values()) flagCount += f.length;
  return {
    accounts: accounts.length,
    fills: fillCount,
    orders: orderCount,
    trades: enrichedTrades.length,
    flags: flagCount,
  };
}
