// Read-model assemblers over the existing repos + pure core. No I/O beyond the local DB; these
// feed the JSON API. Money is NEVER summed across currencies — each row keeps its own currency and
// the API groups per currency.
import type { Database } from "bun:sqlite";
import type { Flag, RawFill, RawOrder, StopInfo, Trade } from "../domain/types";
import type { Journal } from "../domain/journal-types";
import { inferStops } from "../core/stop-inference";
import { positionMetrics } from "../core/position-metrics";
import {
  allRawFills,
  allRawOrders,
  allTrades,
  flagsForTrade,
  positionsAt,
  snapshotClock,
} from "../store/repos";
import { distinctEmotions, distinctSetups, distinctTags, getJournal } from "../store/journal";
import { equityAsOf, latestEquityByCurrency } from "../store/funds";
import pkg from "../../package.json";

export interface OpenPosition {
  account: string;
  symbol: string;
  currency: string;
  qty: number; // signed
  avgCost: number;
  price: number | null; // current market price from the latest snapshot (FUTU's mark); null when unknown
  liveStop: number | null; // the stop STILL WORKING now (excludes cancelled/filled); null when unprotected
  // "If stopped at the current stop" — a signed outcome (own currency), and its two sides:
  stopOutcome: number | null; // (stop − avgCost) × qty; − loss / + locked profit; null when no stop
  openRisk: number | null; // loss still exposed = max(0, −stopOutcome); 0 on a free trade; null when no stop
  lockedProfit: number | null; // guaranteed profit if stopped = max(0, stopOutcome)
  unrealized: number | null; // paper P&L now = (price − avgCost) × qty; null when price unknown
  initialRisk: number | null; // the trade's 1R in this currency (its initial dollar risk); null when unknown
  stopOutcomeR: number | null; // stopOutcome ÷ initialRisk (signed; ≥ 0 ⇒ free trade)
  unrealizedR: number | null; // unrealized ÷ initialRisk — "how many R up am I now"
  freeTrade: boolean; // stop locks in ≥ breakeven — no downside left
  tradeId: string | null; // the open trade this holding belongs to → deep-link to its detail page
}

/** Current holdings from the snapshot at `snapshotTime`, joined to the open trade's stop + initial
 * risk to produce R-framed open-risk / locked-profit / unrealized metrics. Each row keeps its own
 * currency (callers group per currency; never sum dollars across — R is unitless and may). */
export function openPositions(db: Database, snapshotTime: number): OpenPosition[] {
  const snap = positionsAt(db, snapshotTime);
  const tradeBy = new Map<string, Trade>();
  for (const t of allTrades(db)) {
    if (t.status === "open") tradeBy.set(`${t.account}|${t.symbol}`, t);
  }
  return snap.map((p) => {
    const trade = tradeBy.get(`${p.account}|${p.symbol}`);
    // Live risk readout: the stop STILL WORKING now (not the effective/ever-seen stop, which may have
    // been cancelled — that would show a cancelled profit-side stop as a "free trade" with zero risk).
    const liveStop = trade?.liveStop ?? null;
    const initialRisk = trade?.risk ?? null;
    const m = positionMetrics({ avgCost: p.avgCost, qty: p.qty, price: p.price, stop: liveStop, initialRisk });
    return {
      account: p.account,
      symbol: p.symbol,
      currency: p.currency,
      qty: p.qty,
      avgCost: p.avgCost,
      price: p.price,
      liveStop,
      stopOutcome: m.stopOutcome,
      openRisk: m.openRisk,
      lockedProfit: m.lockedProfit,
      unrealized: m.unrealized,
      initialRisk,
      stopOutcomeR: m.stopOutcomeR,
      unrealizedR: m.unrealizedR,
      freeTrade: m.freeTrade,
      tradeId: trade?.id ?? null,
    };
  });
}

/** The latest position-snapshot time (0 if none) — the batch a caller renders as "current". Uses
 * the persisted snapshot marker (so an all-flat sync, which writes no rows, correctly reports zero
 * holdings instead of a stale prior batch); snapshotClock backfills a pre-marker migrated DB. */
export function latestSnapshotTime(db: Database): number {
  return snapshotClock(db, 0);
}

export type EquityBasis = "at_open" | "latest" | "none";
export interface TradeSizing {
  accountEquity: number | null; // denominator, in the trade's currency
  equityBasis: EquityBasis;
  riskPct: number | null; // planned risk / equity
  positionSize: number; // capital committed at max size (avgEntry × maxQty)
  sizePct: number | null; // positionSize / equity
}

/** Per-trade sizing as a fraction of account equity (SAME currency — never mix). `equityBasis`:
 * "at_open" when a funds snapshot at/before the open exists (precise), else "latest" (approximate),
 * else "none". Shared by the trade-detail view and the trades-list rows so both read identical
 * numbers. */
export function tradeSizing(db: Database, trade: Trade): TradeSizing {
  const atOpen = equityAsOf(db, trade.account, trade.currency, trade.openTime);
  const latest =
    atOpen === null ? latestEquityByCurrency(db, trade.account).get(trade.currency) ?? null : null;
  const equity = atOpen ?? latest;
  const equityBasis: EquityBasis = atOpen !== null ? "at_open" : latest !== null ? "latest" : "none";
  const usable = equity !== null && equity > 0;
  const riskPct = trade.risk !== null && usable ? trade.risk / equity : null;
  const positionSize = trade.avgEntry * trade.maxQty;
  const sizePct = usable ? positionSize / equity : null;
  return { accountEquity: equity, equityBasis, riskPct, positionSize, sizePct };
}

export interface TradeDetail {
  trade: Trade;
  fills: RawFill[];
  orders: RawOrder[];
  flags: Flag[];
  stop: StopInfo; // inferred provenance (the stored trade already reflects any manual override)
  journal: Journal | null;
  // Planned risk as a fraction of account equity, same currency. `equityBasis` says which equity:
  //  - "at_open": a snapshot preceded the trade open — precise (the norm for trades opened after a
  //    prior sync captured funds);
  //  - "latest": no snapshot preceded the open, so we approximate with the newest equity snapshot
  //    (OpenD has no historical-funds query — this is the honest fallback for older trades);
  //  - "none": no equity snapshot at all → riskPct null.
  riskPct: number | null;
  accountEquity: number | null; // equity used as the denominator, in the trade's currency
  equityBasis: "at_open" | "latest" | "none";
  // Capital committed at max size (avgEntry × maxQty), in the trade's currency, and as a fraction of
  // account equity (same `equityBasis` as riskPct) — "this trade was N% of the account".
  positionSize: number;
  sizePct: number | null;
  // Current signed holding for an OPEN trade, from the latest positions snapshot (FUTU's own ground
  // truth) — reversal-safe, unlike summing this trade's fills (a flip-through-zero fill is split across
  // two trades but returned at full qty). 0 when flat / no snapshot. `positionAsOf` is that snapshot's
  // clock, so the UI can say how fresh the holding/stop are (they only move on sync).
  currentQty: number;
  positionAsOf: number;
}

export function tradeDetail(db: Database, id: string): TradeDetail | null {
  const trade = allTrades(db).find((t) => t.id === id);
  if (!trade) return null;
  const fillSet = new Set(trade.fillIds);
  const fills = allRawFills(db).filter((f) => fillSet.has(f.id));
  const orders = allRawOrders(db).filter(
    (o) => o.account === trade.account && o.symbol === trade.symbol,
  );
  const { accountEquity: equity, equityBasis, riskPct, positionSize, sizePct } = tradeSizing(db, trade);
  // Current holding from the latest snapshot (only meaningful while open; a closed trade is flat).
  const positionAsOf = latestSnapshotTime(db);
  const held =
    trade.status === "open"
      ? positionsAt(db, positionAsOf).find(
          (p) => p.account === trade.account && p.symbol === trade.symbol,
        )
      : undefined;
  return {
    trade,
    fills,
    orders,
    flags: flagsForTrade(db, id),
    stop: inferStops(trade, orders),
    journal: getJournal(db, id),
    riskPct,
    accountEquity: equity,
    equityBasis,
    positionSize,
    sizePct,
    currentQty: held?.qty ?? 0,
    positionAsOf,
  };
}

/** Open positions grouped per currency, with each currency's total open risk vs latest account
 * equity. Equity/risk are compared within a single currency only (never summed across). */
export interface CurrencyPositions {
  currency: string;
  positions: OpenPosition[];
  totalOpenRisk: number | null; // sum of openRisk over rows that have one (null when none do)
  totalLockedProfit: number | null; // sum of lockedProfit over rows that have a stop
  totalUnrealized: number | null; // sum of unrealized P&L over rows with a known price
  // Honesty flags for the sums above — a total silently omits rows it can't quantify, so surface how
  // many were left out. An UNPROTECTED position (no live stop) is the highest-risk case, yet it
  // contributes nothing to totalOpenRisk; without this the total reads as the whole book when it isn't.
  positionsWithoutStop: number; // rows with no live stop → excluded from totalOpenRisk
  positionsWithoutPrice: number; // rows with no price → excluded from totalUnrealized
  deployed: number; // capital deployed = Σ |qty| × avgCost across this currency's holdings
  equity: number | null; // latest equity snapshot in this currency
  riskPct: number | null; // totalOpenRisk / equity
  unrealizedPct: number | null; // totalUnrealized / equity
  deployedPct: number | null; // deployed / equity — how much of the account is committed
}

/** Portfolio totals in R. R is dimensionless (P&L ÷ the trade's own initial risk), so unlike dollars
 * these DO sum across currencies — the honest whole-book "how much am I risking / up, in R". */
export interface RTotals {
  openRisk: number | null; // Σ over positions of the loss-side R still at stake (0 on free trades)
  unrealized: number | null; // Σ of unrealized R across the book
  // Counts of open positions the totals above could NOT include (no live stop / no price / no 1R
  // basis) — a whole-book total that silently drops the riskiest (unprotected) rows would understate
  // risk, so the UI caveats the figure with these instead of presenting a partial sum as complete.
  positionsWithoutStop: number; // no live stop → not in openRisk (unprotected = real, unquantified risk)
  positionsExcludedFromRisk: number; // stopOutcomeR unknown (no stop OR no 1R basis) → not in openRisk
  positionsWithoutPrice: number; // no price → not in unrealized
}

export interface PositionsResponse {
  byCurrency: CurrencyPositions[];
  rTotals: RTotals;
}

function sumOrNull(xs: (number | null)[]): number | null {
  const present = xs.filter((x): x is number => x !== null);
  return present.length ? present.reduce((a, b) => a + b, 0) : null;
}

export function openPositionsByCurrency(db: Database, snapshotTime: number): PositionsResponse {
  const positions = openPositions(db, snapshotTime);
  const equityByCcy = new Map<string, Map<string, number>>(); // account → (currency → equity)
  const groups = new Map<string, OpenPosition[]>();
  for (const p of positions) {
    const arr = groups.get(p.currency) ?? [];
    arr.push(p);
    groups.set(p.currency, arr);
    if (!equityByCcy.has(p.account)) equityByCcy.set(p.account, latestEquityByCurrency(db, p.account));
  }
  const byCurrency = [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([currency, ps]) => {
      const totalOpenRisk = sumOrNull(ps.map((p) => p.openRisk));
      const totalLockedProfit = sumOrNull(ps.map((p) => p.lockedProfit));
      const totalUnrealized = sumOrNull(ps.map((p) => p.unrealized));
      const positionsWithoutStop = ps.filter((p) => p.stopOutcome === null).length;
      const positionsWithoutPrice = ps.filter((p) => p.unrealized === null).length;
      // Deployed capital: sum notional (|qty| × avgCost) — same currency only, an exposure sum (not P&L).
      const deployed = ps.reduce((a, p) => a + Math.abs(p.qty) * p.avgCost, 0);
      // Sum equity for this currency across the DISTINCT accounts holding it (each account's own
      // snapshot counted once). If ANY contributing account lacks an equity snapshot the denominator is
      // incomplete — leave equity null (→ % null, shown as "equity n/a") rather than dividing this
      // currency's full deployed/risk by a partial equity, which would overstate exposure.
      let equity: number | null = 0;
      for (const account of new Set(ps.map((p) => p.account))) {
        const e = equityByCcy.get(account)?.get(currency);
        if (e === undefined) {
          equity = null;
          break;
        }
        equity += e;
      }
      const pct = (n: number | null) => (n !== null && equity !== null && equity > 0 ? n / equity : null);
      return {
        currency,
        positions: ps,
        totalOpenRisk,
        totalLockedProfit,
        totalUnrealized,
        positionsWithoutStop,
        positionsWithoutPrice,
        deployed,
        equity,
        riskPct: pct(totalOpenRisk),
        unrealizedPct: pct(totalUnrealized),
        deployedPct: pct(deployed),
      };
    });
  // R totals across the whole book (R is unitless, so cross-currency summing is valid).
  const rTotals: RTotals = {
    openRisk: sumOrNull(positions.map((p) => (p.stopOutcomeR === null ? null : Math.max(0, -p.stopOutcomeR)))),
    unrealized: sumOrNull(positions.map((p) => p.unrealizedR)),
    positionsWithoutStop: positions.filter((p) => p.stopOutcome === null).length,
    positionsExcludedFromRisk: positions.filter((p) => p.stopOutcomeR === null).length,
    positionsWithoutPrice: positions.filter((p) => p.unrealizedR === null).length,
  };
  return { byCurrency, rTotals };
}

export interface Meta {
  accounts: string[];
  currencies: string[];
  setups: string[];
  tags: string[];
  emotions: string[];
  coverageStart: number | null;
  appVersion: string;
}

export function metaView(db: Database): Meta {
  const accounts = (
    db
      .query(`SELECT account FROM trades UNION SELECT account FROM raw_fills ORDER BY account ASC`)
      .all() as any[]
  ).map((r) => r.account as string);
  const currencies = (
    db.query(`SELECT DISTINCT currency FROM trades ORDER BY currency ASC`).all() as any[]
  ).map((r) => r.currency as string);
  const cov = db.query(`SELECT MIN(coverage_start) AS c FROM sync_state`).get() as {
    c: number | null;
  };
  return {
    accounts,
    currencies,
    setups: distinctSetups(db),
    tags: distinctTags(db),
    emotions: distinctEmotions(db),
    coverageStart: cov?.c ?? null,
    appVersion: (pkg as { version?: string }).version ?? "0.0.0",
  };
}
