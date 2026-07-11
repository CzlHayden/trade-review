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
} from "../store/repos";
import { distinctSetups, distinctTags, getJournal } from "../store/journal";
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

/** The latest position-snapshot time (0 if none) — the batch a caller renders as "current". */
export function latestSnapshotTime(db: Database): number {
  const row = db.query(`SELECT MAX(time) AS t FROM raw_positions`).get() as { t: number | null };
  return row?.t ?? 0;
}

export interface TradeDetail {
  trade: Trade;
  fills: RawFill[];
  orders: RawOrder[];
  flags: Flag[];
  stop: StopInfo; // inferred provenance (the stored trade already reflects any manual override)
  journal: Journal | null;
}

export function tradeDetail(db: Database, id: string): TradeDetail | null {
  const trade = allTrades(db).find((t) => t.id === id);
  if (!trade) return null;
  const fillSet = new Set(trade.fillIds);
  const fills = allRawFills(db).filter((f) => fillSet.has(f.id));
  const orders = allRawOrders(db).filter(
    (o) => o.account === trade.account && o.symbol === trade.symbol,
  );
  return {
    trade,
    fills,
    orders,
    flags: flagsForTrade(db, id),
    stop: inferStops(trade, orders),
    journal: getJournal(db, id),
  };
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
