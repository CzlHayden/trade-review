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
}

/** A reconstructed round-trip trade. */
export interface Trade {
  id: string; // deterministic: `${account}:${symbol}:${openTime}`
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
}
