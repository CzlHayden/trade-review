import type { Candle, RawFill, RawOrder, RawPosition } from "./types";

/** A trading account as surfaced by OpenD (Trd_GetAccList). */
export interface Account {
  id: string; // accID (uint64) as a string
  trdEnv: number; // 0 = simulate, 1 = real
  markets: number[]; // trdMarketAuthList (TrdMarket enum values)
}

/** Read-only access to OpenD. Times are epoch ms; the live impl formats them to FUTU strings. */
export interface FutuClient {
  getAccounts(): Promise<Account[]>;
  getHistoryFills(account: Account, market: number, beginMs: number, endMs: number): Promise<RawFill[]>;
  getHistoryOrders(account: Account, market: number, beginMs: number, endMs: number): Promise<RawOrder[]>;
  getPositions(account: Account, market: number): Promise<RawPosition[]>;
  close(): void;
}

/** OHLC source for MAE/MFE + charts. `resMs` is the bar duration in ms. */
export interface CandleSource {
  getCandles(symbol: string, fromMs: number, toMs: number, resMs: number): Promise<Candle[]>;
}
