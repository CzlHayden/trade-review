import type { RawFill, Side } from "../src/domain/types";

let seq = 0;
/** Concise fill builder. time defaults to a monotonically increasing minute. */
export function fill(side: Side, qty: number, price: number, over: Partial<RawFill> = {}): RawFill {
  seq += 1;
  return {
    id: over.id ?? `f${seq}`,
    orderId: over.orderId ?? `o${seq}`,
    symbol: over.symbol ?? "AAPL",
    side,
    qty,
    price,
    fee: over.fee ?? 0,
    currency: over.currency ?? "USD",
    time: over.time ?? seq * 60_000,
    account: over.account ?? "acc1",
  };
}
