import type { Database } from "bun:sqlite";
import type { CandleSource, FutuClient } from "../domain/ports";
import type { Candle, Flag, RawFill, RawPosition, RuleConfig, SeedPosition, Trade } from "../domain/types";
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
  flagsForTrade,
  insertPositionSnapshot,
  positionsAt,
  replaceDerived,
  upsertRawFills,
  upsertRawOrders,
} from "../store/repos";
import { manualStops } from "../store/journal";
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

const POS_EPS = 1e-9;

/**
 * Reconstruct the position that existed BEFORE our data window, per (account, symbol), so trades
 * touching pre-window shares are built as coverage-incomplete instead of phantom opposite-direction
 * trades (which would corrupt realized P&L — the non-negotiable money-math invariant).
 *
 * Identity: `startPos = currentSnapshotQty − Σ(all stored fills)`. If the fills fully explain the
 * current holding, startPos ≈ 0 and no seed is needed. A non-zero startPos means the holding predates
 * coverage; seed it (buildTrades marks seeded trades coverageOk:false → excluded from stats). avgCost
 * is best-effort (the snapshot's, or 0 when the lot was closed in-window) — it only affects the
 * excluded coverage-incomplete trade, never a stats-eligible one.
 */
export function deriveSeeds(fills: RawFill[], snapshots: RawPosition[], fallbackTime: number): SeedPosition[] {
  const net = new Map<string, number>();
  const currency = new Map<string, string>();
  const firstTime = new Map<string, number>();
  for (const f of fills) {
    const k = `${f.account}|${f.symbol}`;
    net.set(k, (net.get(k) ?? 0) + (f.side === "BUY" ? f.qty : -f.qty));
    if (!currency.has(k)) currency.set(k, f.currency);
    firstTime.set(k, Math.min(firstTime.get(k) ?? Number.POSITIVE_INFINITY, f.time));
  }
  const snap = new Map<string, RawPosition>();
  for (const s of snapshots) snap.set(`${s.account}|${s.symbol}`, s);

  const seeds: SeedPosition[] = [];
  for (const k of new Set([...net.keys(), ...snap.keys()])) {
    const idx = k.indexOf("|");
    const account = k.slice(0, idx);
    const symbol = k.slice(idx + 1);
    const s = snap.get(k);
    const startPos = (s?.qty ?? 0) - (net.get(k) ?? 0);
    if (Math.abs(startPos) < POS_EPS) continue; // fills fully explain the current holding
    seeds.push({
      account,
      symbol,
      qty: startPos,
      avgCost: s?.avgCost ?? 0,
      currency: s?.currency ?? currency.get(k) ?? "UNKNOWN",
      time: Number.isFinite(firstTime.get(k)) ? firstTime.get(k)! : fallbackTime,
    });
  }
  return seeds;
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
 * Phase 1 — pull raw data from OpenD and persist it (raw upserts are keyed/idempotent). Touches
 * the network; does NOT rebuild derived data. Returns the count of real accounts pulled so the
 * `runSync` wrapper can assemble its summary.
 */
export async function pullRaw(
  db: Database,
  client: FutuClient,
  opts: { now: number; historyDays?: number },
): Promise<{ accounts: number }> {
  const { now } = opts;
  const historyDays = opts.historyDays ?? 90;

  // FUTU returns real AND simulate accounts; only real ones have queryable history and belong in
  // the review DB. Sync only recognized markets (skip futures/funds/unknown).
  const accounts = (await client.getAccounts()).filter((a) => a.trdEnv === TRD_ENV_REAL);

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

      // Orders MUTATE after creation (a trailed/cancelled stop changes status + auxPrice), and FUTU
      // filters history orders by CREATE time — so an incremental window would never refetch a moved
      // stop. Always pull the full window for orders (volume is low). Bound: orders older than
      // historyDays whose stop moved recently still won't refresh — acceptable for v1 swing horizons.
      const orders = await client.getHistoryOrders(acc, market, fullWindowBegin, endMs);
      if (orders.length) upsertRawOrders(db, orders);

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

  return { accounts: accounts.length };
}

/**
 * Phase 2 — rebuild ALL derived trades/flags from the full raw set. Pure of the network: it reads
 * only the local DB (+ candles) and fully replaces derived data, so it is also the recompute path
 * for a manual-stop or rule-config edit (no OpenD round-trip). Candle-fetch failure degrades to no
 * MAE/MFE. A user-entered manual stop (journal) overrides the order-inferred stop for risk/R/flags.
 */
export async function rebuildDerived(
  db: Database,
  opts: { candles: CandleSource; config: RuleConfig; now: number },
): Promise<void> {
  const { candles, config, now } = opts;

  // Prior derived trades, keyed by id — used to carry forward MAE/MFE if candles degrade this run,
  // so a transient Yahoo outage can't overwrite previously-correct excursions (and the flags that
  // depend on them) with nulls. Trade ids are deterministic, so an unchanged trade keeps its key.
  const prior = new Map(allTrades(db).map((t) => [t.id, t] as const));

  const allFills = allRawFills(db);
  const allOrders = allRawOrders(db);
  const manual = manualStops(db); // trade id → user-entered stop (authoritative over inference)
  // Seed positions that predate our data window (reconciled against the current snapshot) so a
  // holding opened before coverage and sold inside it is built as coverage-incomplete rather than a
  // phantom opposite-direction trade with wrong P&L. See deriveSeeds.
  const seeds = deriveSeeds(allFills, positionsAt(db, now), now);
  const built = buildTrades(allFills, seeds).sort(
    (a, b) => a.openTime - b.openTime || a.id.localeCompare(b.id),
  );

  const enrichedTrades: Trade[] = [];
  const flagMap = new Map<string, Flag[]>();

  for (const t of built) {
    const symbolOrders = allOrders.filter((o) => o.account === t.account && o.symbol === t.symbol);
    const stop = inferStops(t, symbolOrders);
    // Manual stop (if set) overrides inference for BOTH the planned-risk basis and the effective
    // stop, so risk/R and the held_past_stop rule all read the user's explicit stop. TP is still
    // inference-only (no manual TP field in v1).
    const ms = manual.get(t.id);
    const initialStop = ms ?? stop.initialStop; // initial = planned risk (spec §6)
    const effectiveStop = ms ?? stop.effectiveStop;
    const { risk, rMultiple } = computeRisk(t, initialStop);

    const resMs = resolutionMs(t);
    const from = t.openTime - PAD_MS;
    const to = (t.closeTime ?? now) + PAD_MS;
    let bars: Candle[] = [];
    try {
      bars = await candles.getCandles(t.symbol, from, to, resMs);
    } catch {
      bars = []; // a candle-source rejection must not abort the whole sync (contract: degrade to no MAE/MFE)
    }
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
      effectiveStop,
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
}

/**
 * Full sync: pull raw from OpenD, then rebuild derived. Thin wrapper over pullRaw + rebuildDerived
 * used by the CLI and the "Sync now" job. Reports DISTINCT stored counts (OpenD returns an account's
 * rows across every market-header query, so a per-pull sum would double-count).
 */
export async function runSync(deps: SyncDeps): Promise<SyncResult> {
  const { db, client, candles, config, now } = deps;
  const { accounts } = await pullRaw(db, client, { now, historyDays: deps.historyDays });
  await rebuildDerived(db, { candles, config, now });

  const trades = allTrades(db);
  let flagCount = 0;
  for (const t of trades) flagCount += flagsForTrade(db, t.id).length;
  return {
    accounts,
    fills: allRawFills(db).length,
    orders: allRawOrders(db).length,
    trades: trades.length,
    flags: flagCount,
  };
}
