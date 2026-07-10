import type { RawFill, RawOrder, OrderType, SeedPosition, Side, Candle } from "../src/domain/types";

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

/** Concise seed-position builder. `qty` is signed (+long / -short); `avgCost` is per-share basis. */
export function seedPos(qty: number, avgCost: number, over: Partial<SeedPosition> = {}): SeedPosition {
  return {
    account: over.account ?? "acc1",
    symbol: over.symbol ?? "AAPL",
    qty,
    avgCost,
    currency: over.currency ?? "USD",
    time: over.time ?? 0,
  };
}

let oseq = 0;
export function order(
  side: Side,
  type: OrderType,
  qty: number,
  over: Partial<RawOrder> = {},
): RawOrder {
  oseq += 1;
  return {
    id: over.id ?? `ord${oseq}`,
    symbol: over.symbol ?? "AAPL",
    side,
    type,
    qty,
    price: over.price ?? null,
    triggerPrice: over.triggerPrice ?? null,
    status: over.status ?? "SUBMITTED",
    createTime: over.createTime ?? oseq * 60_000,
    updateTime: over.updateTime ?? null,
    account: over.account ?? "acc1",
  };
}

export function candle(time: number, low: number, high: number, over: Partial<Candle> = {}): Candle {
  return {
    time,
    open: over.open ?? (low + high) / 2,
    high,
    low,
    close: over.close ?? (low + high) / 2,
    volume: over.volume ?? 1000,
  };
}
