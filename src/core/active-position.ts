// Live metrics for a STILL-OPEN position: how many R you're currently up/down at the latest mark,
// and how many R your current protective stop has already locked in. Pure — no I/O — so it's unit-
// tested exhaustively and safe to bundle into the web client.
//
// The "locked R" idea is the trader's own framing: move your stop to breakeven and you've locked 0R
// (no risk left); move it a full R into profit and you've locked +1R (a guaranteed +1R if it fills).
// It's simply where the current stop sits, measured in R off the entry.
//
// Both figures are expressed on the CURRENT holding (signed qty), so a scaled-out position reports the
// R still live on the shares you're actually holding. Risk (1R) is the trade's PLANNED risk, in the
// trade's own currency — never mixed across currencies.

import type { Direction } from "../domain/types";

const EPS = 1e-9;

export interface ActivePositionInput {
  direction: Direction;
  avgEntry: number;
  /** Signed current holding: LONG > 0, SHORT < 0. */
  currentQty: number;
  /** Latest mark (e.g. the last loaded candle's close). */
  currentPrice: number;
  /** Planned 1R in the trade's currency (|entry − plannedStop| × maxQty), or null when unknown. */
  risk: number | null;
  /** Current protective stop price, or null when none is active. */
  effectiveStop: number | null;
}

export interface ActivePosition {
  /** Unrealized P&L on the current holding at `currentPrice`, in the trade's currency. */
  openPnl: number;
  /** Unrealized P&L as a multiple of planned risk, or null when risk is unknown / zero. */
  openR: number | null;
  /** P&L that would be realized on the current holding if the effective stop filled now
   * ((stop − entry) × signed qty). null when no stop is active. */
  lockedPnl: number | null;
  /** Locked P&L as a multiple of planned risk (0R = breakeven stop, +1R = a full R secured, −1R = the
   * initial risk still fully exposed). null when risk or stop is unknown / zero. */
  lockedR: number | null;
}

/** True when `stop` sits on the losing side of entry (LONG: below; SHORT: above) — i.e. it's still a
 * protective stop that would realize a loss, not one moved into profit. */
export function stopStillAtRisk(direction: Direction, avgEntry: number, stop: number): boolean {
  return direction === "LONG" ? stop < avgEntry : stop > avgEntry;
}

export function activePosition(input: ActivePositionInput): ActivePosition {
  const { avgEntry, currentQty, currentPrice, risk, effectiveStop } = input;
  const haveRisk = risk !== null && risk > EPS;

  // Signed qty makes this direction-agnostic: for a SHORT (qty < 0) a price below entry yields a
  // positive P&L, exactly as it should.
  const openPnl = (currentPrice - avgEntry) * currentQty;
  const openR = haveRisk ? openPnl / risk! : null;

  let lockedPnl: number | null = null;
  let lockedR: number | null = null;
  if (effectiveStop !== null) {
    lockedPnl = (effectiveStop - avgEntry) * currentQty;
    lockedR = haveRisk ? lockedPnl / risk! : null;
  }

  return { openPnl, openR, lockedPnl, lockedR };
}
