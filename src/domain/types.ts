export type Side = "BUY" | "SELL";
export type Direction = "LONG" | "SHORT";
export type TradeStatus = "open" | "closed";

/** One execution as returned by FUTU (a "deal"/fill). qty is always positive. */
export interface RawFill {
  id: string;
  orderId: string;
  symbol: string;
  side: Side;
  qty: number;
  price: number;
  fee: number;
  currency: string;
  time: number; // epoch milliseconds
  account: string;
}

/** A position already open before our fill history begins (from a positions snapshot). */
export interface SeedPosition {
  account: string;
  symbol: string;
  qty: number; // signed: positive = long, negative = short
  avgCost: number; // cost basis per share from the snapshot (so seeded PnL/avgEntry are sane)
  currency: string;
  time: number; // epoch ms of the snapshot (used as openTime when there are no fills)
}

/** A reconstructed round-trip trade. */
export interface Trade {
  id: string; // deterministic: `${account}:${symbol}:${openTime}:${openingFillId}` (collision-safe)
  account: string;
  symbol: string;
  currency: string;
  direction: Direction;
  status: TradeStatus;
  openTime: number;
  closeTime: number | null;
  avgEntry: number;
  avgExit: number | null;
  maxQty: number;
  realizedPnl: number | null;
  fees: number;
  holdSeconds: number | null;
  coverageOk: boolean; // false when the trade began before our data coverage (seeded)
  fillIds: string[];
  // Enrichment fields — null from trade-builder; populated by the sync pipeline (Plan 2+ modules).
  effectiveStop: number | null;
  effectiveTp: number | null;
  risk: number | null;
  rMultiple: number | null;
  mae: number | null;
  mfe: number | null;
}

/** FUTU order type (normalized). Stop/stop-limit/trailing are protective-stop candidates. */
export type OrderType =
  | "MARKET"
  | "LIMIT"
  | "STOP"
  | "STOP_LIMIT"
  | "TRAILING_STOP"
  | "OTHER";

/** An order as returned by FUTU (including cancelled ones). Used to infer protective stops. */
export interface RawOrder {
  id: string;
  symbol: string;
  side: Side;
  type: OrderType;
  qty: number;
  price: number | null; // limit price; null for market/stop-market
  triggerPrice: number | null; // stop trigger; null for non-stop orders
  status: string; // raw FUTU status string (e.g. "FILLED_ALL", "CANCELLED_ALL")
  createTime: number; // epoch ms
  updateTime: number | null; // epoch ms of last modification (a moved stop bumps this, not createTime)
  account: string;
}

/** An OHLC candle. Used for MAE/MFE and (later) charts. */
export interface Candle {
  time: number; // epoch ms, bar start
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Output of stop inference for one trade. */
export interface StopInfo {
  initialStop: number | null; // earliest protective stop — the planned risk (use for R-multiple)
  effectiveStop: number | null; // latest protective stop — what was actually protecting at the end
  effectiveTp: number | null;
  stopOrderId: string | null; // id of the order behind effectiveStop (provenance)
  stopQty: number | null; // qty that stop covered (may be < position size)
  receipt: string | null; // plain-English explanation of the matched stop (spec §6)
}
