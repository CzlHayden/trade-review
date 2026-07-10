import type { RawOrder, StopInfo, Trade } from "../domain/types";

const STOP_TYPES = new Set(["STOP", "STOP_LIMIT", "TRAILING_STOP"]);
const EPS = 1e-9;

/** The side of an order that would REDUCE this trade's position. */
function closingSide(trade: Trade): "BUY" | "SELL" {
  return trade.direction === "LONG" ? "SELL" : "BUY";
}

/** Is the order within the trade's open window and on the same instrument/account/side/qty? */
function isProtective(trade: Trade, o: RawOrder): boolean {
  if (o.account !== trade.account || o.symbol !== trade.symbol) return false;
  if (o.side !== closingSide(trade)) return false;
  if (o.qty > trade.maxQty + EPS) return false;
  if (o.createTime < trade.openTime) return false;
  if (trade.closeTime !== null && o.createTime > trade.closeTime) return false;
  return true;
}

/** Latest-by-createTime value among matching orders, or null. */
function latest(orders: RawOrder[], pick: (o: RawOrder) => number | null): number | null {
  let best: RawOrder | null = null;
  let bestVal: number | null = null;
  for (const o of orders) {
    const v = pick(o);
    if (v === null) continue;
    if (best === null || o.createTime > best.createTime) {
      best = o;
      bestVal = v;
    }
  }
  return bestVal;
}

export function inferStops(trade: Trade, orders: RawOrder[]): StopInfo {
  const candidates = orders.filter((o) => isProtective(trade, o));

  // Stop-loss: a stop-type order with trigger on the LOSS side of entry.
  const stopVal = latest(candidates, (o) => {
    if (!STOP_TYPES.has(o.type) || o.triggerPrice === null) return null;
    const onLossSide =
      trade.direction === "LONG"
        ? o.triggerPrice < trade.avgEntry
        : o.triggerPrice > trade.avgEntry;
    return onLossSide ? o.triggerPrice : null;
  });

  // Take-profit: a limit order with price on the PROFIT side of entry.
  const tpVal = latest(candidates, (o) => {
    if (o.type !== "LIMIT" || o.price === null) return null;
    const onProfitSide =
      trade.direction === "LONG" ? o.price > trade.avgEntry : o.price < trade.avgEntry;
    return onProfitSide ? o.price : null;
  });

  return { effectiveStop: stopVal, effectiveTp: tpVal };
}
