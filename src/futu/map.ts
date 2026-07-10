// Pure mappers: already-decoded FUTU objects (the SDK returns plain JS, not protobuf buffers)
// → domain rows. Enum values and field names are from node_modules/futu-api/proto/Trd_Common.proto.
//
// v1 LIMITATION — fees: historical fills (Trd_Common.OrderFill) carry no fee field, so `fee` is
// set to 0 and `realizedPnl` is therefore GROSS of commissions. A later plan can enrich via
// Trd_GetOrderFee. Orders/positions do carry a currency enum; fills derive currency from market.

import type { Account } from "../domain/ports";
import type { OrderType, RawFill, RawOrder, RawPosition, Side } from "../domain/types";

/** TrdEnv_Real (Trd_Common.proto). */
export const TRD_ENV_REAL = 1;

const STOP_TYPES = new Set<OrderType>(["STOP", "STOP_LIMIT", "TRAILING_STOP"]);

// ---- market / currency / symbol -----------------------------------------------

const MARKET_PREFIX: Record<number, string> = {
  1: "HK", 2: "US", 3: "CN", 4: "HK", 6: "SG", 8: "AU", 15: "JP", 111: "MY", 112: "CA",
};
// Distinct from MARKET_PREFIX: used as the sync_state cursor key, so it must be UNIQUE per market
// (HK=1 and HKCC=4 share the "HK" symbol prefix but must not share a sync cursor, or the second
// market inherits the first's lastSyncedTime and skips its history).
const MARKET_NAME: Record<number, string> = {
  1: "HK", 2: "US", 3: "CN", 4: "HKCC", 6: "SG", 8: "AU", 15: "JP", 111: "MY", 112: "CA",
};
const MARKET_CURRENCY: Record<number, string> = {
  1: "HKD", 2: "USD", 3: "CNH", 4: "HKD", 6: "SGD", 8: "AUD", 15: "JPY", 111: "MYR", 112: "CAD",
};
const ENUM_CURRENCY: Record<number, string> = {
  1: "HKD", 2: "USD", 3: "CNH", 4: "JPY", 5: "SGD", 6: "AUD", 7: "CAD", 8: "MYR",
};

/** Domain symbol: `"<MKT>.<code>"` (e.g. "US.AAPL", "HK.00700"). */
export function futuSymbol(code: string, market: number): string {
  return `${MARKET_PREFIX[market] ?? "UNKNOWN"}.${code}`;
}

/** Unique market key used for the sync_state cursor (e.g. 2 → "US", 4 → "HKCC"). */
export function marketName(market: number): string {
  return MARKET_NAME[market] ?? `MKT_${market}`;
}

export function currencyForMarket(market: number): string {
  return MARKET_CURRENCY[market] ?? "UNKNOWN";
}

export function currencyForEnum(cur: number | undefined): string {
  return (cur !== undefined && ENUM_CURRENCY[cur]) || "UNKNOWN";
}

// ---- time ---------------------------------------------------------------------

/** FUTU numeric `*Timestamp` fields are unix SECONDS. Prefer them; fall back to the string form. */
export function toMs(timestamp: number | undefined, timeStr: string | undefined): number {
  if (typeof timestamp === "number" && timestamp > 0) return Math.round(timestamp * 1000);
  if (timeStr) return Date.parse(timeStr.replace(" ", "T"));
  return 0;
}

// ---- enum mappers -------------------------------------------------------------

/** TrdSide: 1=Buy, 2=Sell, 3=SellShort, 4=BuyBack. */
export function sideFrom(trdSide: number): Side {
  return trdSide === 2 || trdSide === 3 ? "SELL" : "BUY";
}

/** OrderType → domain OrderType. */
export function orderTypeFrom(orderType: number): OrderType {
  switch (orderType) {
    case 2:
      return "MARKET";
    case 10:
      return "STOP";
    case 11:
      return "STOP_LIMIT";
    case 14:
    case 15:
      return "TRAILING_STOP";
    case 1:
    case 5:
    case 6:
    case 7:
    case 8:
    case 9:
      return "LIMIT";
    default:
      return "OTHER"; // 12/13 touched, 16–19 TWAP/VWAP, 0 unknown
  }
}

/** OrderStatus → canonical UPPER_SNAKE name so stop-inference's dead-status substring match works. */
const ORDER_STATUS_NAME: Record<number, string> = {
  0: "UNSUBMITTED", [-1]: "UNKNOWN", 1: "WAITING_SUBMIT", 2: "SUBMITTING", 3: "SUBMIT_FAILED",
  4: "TIMEOUT", 5: "SUBMITTED", 10: "FILLED_PART", 11: "FILLED_ALL", 12: "CANCELLING_PART",
  13: "CANCELLING_ALL", 14: "CANCELLED_PART", 15: "CANCELLED_ALL", 21: "FAILED", 22: "DISABLED",
  23: "DELETED", 24: "FILL_CANCELLED",
};
export function orderStatusName(orderStatus: number): string {
  return ORDER_STATUS_NAME[orderStatus] ?? `STATUS_${orderStatus}`;
}

// ---- row mappers --------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */

// protobufjs surfaces omitted optional numeric fields as their proto default 0 (not undefined),
// so `??` won't fall back. Treat 0/absent as "missing" and prefer trdMarket, then secMarket.
function marketOf(raw: any): number {
  return raw.trdMarket || raw.secMarket || 0;
}

export function mapFill(raw: any, account: string): RawFill {
  const market = marketOf(raw);
  return {
    id: String(raw.fillID),
    orderId: String(raw.orderID),
    symbol: futuSymbol(raw.code, market),
    side: sideFrom(raw.trdSide),
    qty: raw.qty,
    price: raw.price,
    fee: 0, // v1: fills carry no fee (see file header)
    currency: currencyForMarket(market),
    time: toMs(raw.createTimestamp, raw.createTime),
    account,
  };
}

export function mapOrder(raw: any, account: string): RawOrder {
  const market = marketOf(raw);
  const type = orderTypeFrom(raw.orderType);
  const triggerPrice = STOP_TYPES.has(type) ? (raw.auxPrice ?? null) : null;
  // Stop-market and market orders have no resting limit price; stop-limit keeps `price`.
  const price = type === "MARKET" || type === "STOP" ? null : (raw.price ?? null);
  return {
    id: String(raw.orderID),
    symbol: futuSymbol(raw.code, market),
    side: sideFrom(raw.trdSide),
    type,
    qty: raw.qty,
    price,
    triggerPrice,
    status: orderStatusName(raw.orderStatus),
    createTime: toMs(raw.createTimestamp, raw.createTime),
    updateTime:
      raw.updateTimestamp !== undefined || raw.updateTime !== undefined
        ? toMs(raw.updateTimestamp, raw.updateTime)
        : null,
    account,
  };
}

export function mapPosition(raw: any, account: string, snapshotMs: number): RawPosition {
  const market = marketOf(raw);
  const qtyAbs = raw.qty;
  // `||` (not `??`): omitted cost fields arrive as 0 from protobufjs; a real cost is never 0.
  const avgCost = raw.averageCostPrice || raw.dilutedCostPrice || raw.costPrice || 0;
  return {
    account,
    symbol: futuSymbol(raw.code, market),
    qty: raw.positionSide === 1 ? -qtyAbs : qtyAbs, // PositionSide: 1 = Short
    avgCost,
    currency: currencyForEnum(raw.currency) !== "UNKNOWN" ? currencyForEnum(raw.currency) : currencyForMarket(market),
    time: snapshotMs,
  };
}

export function mapAccount(raw: any): Account {
  return {
    id: String(raw.accID),
    trdEnv: raw.trdEnv,
    markets: raw.trdMarketAuthList ?? [],
  };
}
