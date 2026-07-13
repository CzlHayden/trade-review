// Typed API client. Base domain types are shared verbatim with the backend (src/domain/types) so
// the currency-segmented shapes are the SAME types across the wire.
import type {
  Breakdown,
  Candle,
  Flag,
  RawFill,
  RawOrder,
  Stats,
  StopInfo,
  Trade,
} from "../../src/domain/types";
import type { Journal, WeeklyEntry, WatchlistItem } from "../../src/domain/journal-types";
import type { Drawing } from "../../src/store/drawings";
import type { Res } from "../../src/core/candle-res"; // single source of truth for the resolution union

export type { Breakdown, Candle, Flag, Stats, Trade, StopInfo, RawFill, RawOrder, Journal, WeeklyEntry, WatchlistItem, Drawing, Res };

/** A trade row from GET /api/trades — base Trade plus embedded journal/flags for the list. */
export interface TradeRow extends Trade {
  flags: Flag[];
  setup: string | null;
  tags: string[];
  sizePct: number | null; // position size as a fraction of account equity ("≈" when basis is "latest")
  equityBasis: "at_open" | "latest" | "none";
}

export interface TradeDetail {
  trade: Trade;
  fills: RawFill[];
  orders: RawOrder[];
  flags: Flag[];
  stop: StopInfo;
  journal: Journal | null;
  riskPct: number | null;
  accountEquity: number | null;
  equityBasis: "at_open" | "latest" | "none";
  positionSize: number; // capital committed at max size (avgEntry × maxQty)
  sizePct: number | null; // positionSize / account equity
  currentQty: number; // signed current holding from the latest snapshot (0 when flat/closed)
  positionAsOf: number; // that snapshot's clock (how fresh the holding/stop are)
}

export interface OpenPosition {
  account: string;
  symbol: string;
  currency: string;
  qty: number;
  avgCost: number;
  price: number | null; // current market price (snapshot); null when unknown
  liveStop: number | null; // the stop still working now (excludes cancelled/filled); null when unprotected
  stopOutcome: number | null; // signed $ if stopped now (− loss / + locked profit)
  openRisk: number | null; // loss still exposed (0 = free trade); null when no stop
  lockedProfit: number | null; // profit locked in if stopped
  unrealized: number | null; // paper P&L now
  initialRisk: number | null; // 1R in this currency
  stopOutcomeR: number | null; // stopOutcome / initialRisk (signed; ≥ 0 ⇒ free trade)
  unrealizedR: number | null; // unrealized / initialRisk
  freeTrade: boolean; // stop locks in ≥ breakeven
  tradeId: string | null;
}
export interface CurrencyPositions {
  currency: string;
  positions: OpenPosition[];
  totalOpenRisk: number | null;
  totalLockedProfit: number | null;
  totalUnrealized: number | null;
  positionsWithoutStop: number; // excluded from totalOpenRisk (no live stop)
  positionsWithoutPrice: number; // excluded from totalUnrealized (no price)
  deployed: number;
  equity: number | null;
  riskPct: number | null;
  unrealizedPct: number | null;
  deployedPct: number | null;
}
/** Portfolio totals in R — dimensionless, so these sum across currencies (unlike dollars). */
export interface RTotals {
  openRisk: number | null;
  unrealized: number | null;
  positionsWithoutStop: number; // unprotected positions omitted from openRisk (real, unquantified risk)
  positionsExcludedFromRisk: number; // positions with unknown R (no stop or no 1R basis) omitted from openRisk
  positionsWithoutPrice: number; // positions omitted from unrealized (no price)
}
export interface PositionsResponse {
  byCurrency: CurrencyPositions[];
  rTotals: RTotals;
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

export interface SyncStatus {
  running: boolean;
  startedAt: number | null;
  finishedAt: number | null;
  lastResult: { accounts: number; fills: number; orders: number; trades: number; flags: number } | null;
  lastError: string | null;
}

export interface WeeklyView extends WeeklyEntry {
  trades: Trade[];
}

/** Notify-only update check against GitHub Releases. `downloadUrl` is the asset for this platform (or
 * null); `error` is set when the check couldn't complete. The app never modifies its own binary. */
export interface UpdateStatus {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  downloadUrl: string | null;
  releaseUrl: string | null;
  error: string | null;
}

/** OpenD connection settings. The key is write-only over the wire — the server returns `hasKey`, never
 * the key itself. Set entirely in the app (config DB); there is no environment override. */
export interface OpendSettings {
  port: number;
  hasKey: boolean;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

async function send<T>(path: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

export const api = {
  stats: () => get<Stats>("/api/stats"),
  breakdowns: (by: string) => get<Breakdown[]>(`/api/breakdowns?by=${by}`),
  trades: () => get<TradeRow[]>("/api/trades"),
  trade: (id: string) => get<TradeDetail>(`/api/trades/${encodeURIComponent(id)}`),
  candles: (id: string, res: Res = "1d") =>
    get<{ res: Res; resMs: number; focusFrom: number; focusTo: number; candles: Candle[] }>(
      `/api/trades/${encodeURIComponent(id)}/candles?res=${res}`,
    ),
  positions: () => get<PositionsResponse>("/api/positions"),
  meta: () => get<Meta>("/api/meta"),
  syncStatus: () => get<SyncStatus>("/api/sync/status"),
  startSync: () => send<SyncStatus>("/api/sync", "POST"),
  quit: () => send<{ quitting: boolean }>("/api/quit", "POST"),
  updateCheck: () => get<UpdateStatus>("/api/update/check"),
  opendSettings: () => get<OpendSettings>("/api/settings/opend"),
  putOpendSettings: (body: { key?: string; port?: number }) =>
    send<OpendSettings>("/api/settings/opend", "PUT", body),
  putJournal: (id: string, body: Record<string, unknown>) =>
    send<TradeDetail>(`/api/trades/${encodeURIComponent(id)}/journal`, "PUT", body),
  drawings: (id: string) => get<{ drawings: Drawing[] }>(`/api/trades/${encodeURIComponent(id)}/drawings`),
  putDrawings: (id: string, drawings: Drawing[]) =>
    send<{ drawings: Drawing[] }>(`/api/trades/${encodeURIComponent(id)}/drawings`, "PUT", { drawings }),
  week: (isoWeek: string) => get<WeeklyView>(`/api/journal/weeks/${isoWeek}`),
  putWeek: (isoWeek: string, body: Record<string, unknown>) =>
    send<WeeklyView>(`/api/journal/weeks/${isoWeek}`, "PUT", body),
};
