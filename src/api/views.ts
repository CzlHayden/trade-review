// Read-model assemblers over the existing repos + pure core. No I/O beyond the local DB; these
// feed the JSON API. Money is NEVER summed across currencies — each row keeps its own currency and
// the API groups per currency.
import type { Database } from "bun:sqlite";
import type { Flag, RawFill, RawOrder, StopInfo, Trade } from "../domain/types";
import type { Journal } from "../domain/journal-types";
import { inferStops } from "../core/stop-inference";
import {
  allRawFills,
  allRawOrders,
  allTrades,
  flagsForTrade,
  positionsAt,
  snapshotClock,
} from "../store/repos";
import { distinctSetups, distinctTags, getJournal } from "../store/journal";
import { equityAsOf, latestEquityByCurrency } from "../store/funds";
import pkg from "../../package.json";

export interface OpenPosition {
  account: string;
  symbol: string;
  currency: string;
  qty: number; // signed
  avgCost: number;
  effectiveStop: number | null;
  openRisk: number | null; // |avgCost − stop| × |qty|, or null when no stop is known
}

/** Current holdings from the snapshot at `snapshotTime`, joined to the open trade's effective stop
 * for open-risk. Each row keeps its own currency (callers group per currency; never sum across). */
export function openPositions(db: Database, snapshotTime: number): OpenPosition[] {
  const snap = positionsAt(db, snapshotTime);
  const stopBy = new Map<string, number | null>();
  for (const t of allTrades(db)) {
    if (t.status === "open") stopBy.set(`${t.account}|${t.symbol}`, t.effectiveStop);
  }
  return snap.map((p) => {
    const effectiveStop = stopBy.get(`${p.account}|${p.symbol}`) ?? null;
    const openRisk =
      effectiveStop === null ? null : Math.abs(p.avgCost - effectiveStop) * Math.abs(p.qty);
    return {
      account: p.account,
      symbol: p.symbol,
      currency: p.currency,
      qty: p.qty,
      avgCost: p.avgCost,
      effectiveStop,
      openRisk,
    };
  });
}

/** The latest position-snapshot time (0 if none) — the batch a caller renders as "current". Uses
 * the persisted snapshot marker (so an all-flat sync, which writes no rows, correctly reports zero
 * holdings instead of a stale prior batch); snapshotClock backfills a pre-marker migrated DB. */
export function latestSnapshotTime(db: Database): number {
  return snapshotClock(db, 0);
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
  const atOpen = equityAsOf(db, trade.account, trade.currency, trade.openTime);
  const latest = atOpen === null ? latestEquityByCurrency(db, trade.account).get(trade.currency) ?? null : null;
  const equity = atOpen ?? latest;
  const equityBasis = atOpen !== null ? "at_open" : latest !== null ? "latest" : "none";
  const riskPct =
    trade.risk !== null && equity !== null && equity > 0 ? trade.risk / equity : null;
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
  equity: number | null; // latest equity snapshot in this currency
  riskPct: number | null; // totalOpenRisk / equity
}

export function openPositionsByCurrency(db: Database, snapshotTime: number): { byCurrency: CurrencyPositions[] } {
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
      const risks = ps.map((p) => p.openRisk).filter((r): r is number => r !== null);
      const totalOpenRisk = risks.length ? risks.reduce((a, b) => a + b, 0) : null;
      // Sum equity for this currency across the DISTINCT accounts holding it (each account's own
      // snapshot counted once, even if it has several positions in this currency).
      let equity: number | null = null;
      for (const account of new Set(ps.map((p) => p.account))) {
        const e = equityByCcy.get(account)?.get(currency);
        if (e !== undefined) equity = (equity ?? 0) + e;
      }
      const riskPct = totalOpenRisk !== null && equity !== null && equity > 0 ? totalOpenRisk / equity : null;
      return { currency, positions: ps, totalOpenRisk, equity, riskPct };
    });
  return { byCurrency };
}

export interface Meta {
  accounts: string[];
  currencies: string[];
  setups: string[];
  tags: string[];
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
    coverageStart: cov?.c ?? null,
    appVersion: (pkg as { version?: string }).version ?? "0.0.0",
  };
}
