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
  effectiveStop: number | null;
  openRisk: number | null;
  tradeId: string | null;
}
export interface CurrencyPositions {
  currency: string;
  positions: OpenPosition[];
  totalOpenRisk: number | null;
  deployed: number;
  equity: number | null;
  riskPct: number | null;
  deployedPct: number | null;
}
export interface PositionsResponse {
  byCurrency: CurrencyPositions[];
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

/** OpenD connection settings. The key is write-only over the wire — the server returns `hasKey`, never
 * the key itself. `managedByEnv` = an env var is overriding stored config (field shown read-only). */
export interface OpendSettings {
  port: number;
  hasKey: boolean;
  managedByEnv: boolean;
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
