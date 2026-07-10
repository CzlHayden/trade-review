import type { Database } from "bun:sqlite";
import type { CandleSource, FutuClient } from "../domain/ports";
import type { Flag, RawPosition, RuleConfig, Trade } from "../domain/types";
import { buildTrades } from "../core/trade-builder";
import { inferStops } from "../core/stop-inference";
import { computeRisk } from "../core/risk";
import { computeExcursion } from "../core/mae-mfe";
import { evaluate } from "../core/rule-engine";
import { knownMarket, marketName, TRD_ENV_REAL } from "../futu/map";
import {
  allRawFills,
  allRawOrders,
  allTrades,
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

  // FUTU returns real AND simulate accounts; only real ones have queryable history and belong in
  // the review DB. Sync only recognized markets (skip futures/funds/unknown).
  const accounts = (await client.getAccounts()).filter((a) => a.trdEnv === TRD_ENV_REAL);
  let fillCount = 0;
  let orderCount = 0;

  for (const acc of accounts) {
    const snapshot: RawPosition[] = [];
    for (const market of acc.markets) {
      if (!knownMarket(market)) continue;
      const mkt = marketName(market);
      const state = getSyncState(db, acc.id, mkt);
      const fullWindowBegin = now - historyDays * DAY_MS;
      const beginMs = state?.lastSyncedTime ?? fullWindowBegin;
      const endMs = now;

      const fills = await client.getHistoryFills(acc, market, beginMs, endMs);
      if (fills.length) upsertRawFills(db, fills);
      fillCount += fills.length;

      // Orders MUTATE after creation (a trailed/cancelled stop changes status + auxPrice), and FUTU
      // filters history orders by CREATE time — so an incremental window would never refetch a moved
      // stop. Always pull the full window for orders (volume is low). Bound: orders older than
      // historyDays whose stop moved recently still won't refresh — acceptable for v1 swing horizons.
      const orders = await client.getHistoryOrders(acc, market, fullWindowBegin, endMs);
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
  // Prior derived trades, keyed by id — used to carry forward MAE/MFE if candles degrade this run,
  // so a transient Yahoo outage can't overwrite previously-correct excursions (and the flags that
  // depend on them) with nulls. Trade ids are deterministic, so an unchanged trade keeps its key.
  const prior = new Map(allTrades(db).map((t) => [t.id, t] as const));

  const allFills = allRawFills(db);
  const allOrders = allRawOrders(db);
  // v1 LIMITATION — no seeds: a position opened BEFORE the sync window that is sold inside it has
  // no opening BUY in our data, so trade-builder reads the lone SELL as a phantom SHORT open with
  // coverageOk:true (wrong direction/PnL, and rules run on it). Correct fix = pre-existing-position
  // seeding (buildTrades already accepts seeds + marks coverageOk:false). Tracked as a follow-up.
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
    const excursion = computeExcursion(t, bars, resMs);
    // Degrade safely: if candles are unavailable this run, keep any excursion computed on a prior
    // sync rather than nulling it (which would silently drop mae/mfe-dependent flags). But ONLY when
    // the trade's window/shape is unchanged — a trade whose id persisted while it gained fills (e.g.
    // open → closed, or scaled) has a different window, so the old excursion would be stale.
    const priorT = prior.get(t.id);
    const sameShape =
      priorT !== undefined &&
      priorT.closeTime === t.closeTime &&
      priorT.avgEntry === t.avgEntry &&
      priorT.maxQty === t.maxQty;
    const mae = excursion.mae ?? (sameShape ? priorT.mae : null);
    const mfe = excursion.mfe ?? (sameShape ? priorT.mfe : null);

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
