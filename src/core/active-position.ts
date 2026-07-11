// Live metrics for a STILL-OPEN position: how many R you're currently up/down at the latest mark,
// and how many R your current protective stop has already locked in. Pure — no I/O — so it's unit-
// tested exhaustively and safe to bundle into the web client.
//
// Two distinct measures:
//  - openR  — UNREALIZED P&L on the shares you're actually holding right now, as a multiple of planned
//             risk. Qty-weighted: scale out and the R you're carrying shrinks with the holding.
//  - lockedR — where your protective stop SITS, measured in R off entry. A pure price level, qty-
//             independent (it's the trader's own framing: "move the stop to 0R" = breakeven, no risk
//             left; "to +1R" = a full R secured; it stays at −1R while the stop is at the planned stop,
//             i.e. the full initial risk is still on). This is the same yardstick as planned risk, so
//             it's normalized by risk-per-share (risk / maxQty), NOT the current holding.
//
// Risk (1R) is the trade's PLANNED risk in the trade's own currency (|entry − plannedStop| × maxQty) —
// never mixed across currencies.

import type { Direction } from "../domain/types";

const EPS = 1e-9;

export interface ActivePositionInput {
  direction: Direction;
  avgEntry: number;
  /** Signed current holding: LONG > 0, SHORT < 0. */
  currentQty: number;
  /** Latest mark (e.g. the last loaded candle's close). */
  currentPrice: number;
  /** The size the planned risk was based on (max position reached) — the basis for the R yardstick. */
  maxQty: number;
  /** Planned 1R in the trade's currency (|entry − plannedStop| × maxQty), or null when unknown. */
  risk: number | null;
  /** Current protective stop price, or null when none is active. */
  effectiveStop: number | null;
}

export interface ActivePosition {
  /** Unrealized P&L on the current holding at `currentPrice`, in the trade's currency (gross of fees). */
  openPnl: number;
  /** Unrealized P&L as a multiple of planned risk, or null when risk is unknown / zero. */
  openR: number | null;
  /** Where the effective stop sits, in R off entry (0R = breakeven, +1R = a full R secured, −1R = the
   * initial risk still fully on). Qty-independent. null when risk or stop is unknown / zero. */
  lockedR: number | null;
}

export function activePosition(input: ActivePositionInput): ActivePosition {
  const { direction, avgEntry, currentQty, currentPrice, maxQty, risk, effectiveStop } = input;
  const haveRisk = risk !== null && risk > EPS;

  // Signed qty makes P&L direction-agnostic: for a SHORT (qty < 0) a price below entry yields a
  // positive P&L, exactly as it should.
  const openPnl = (currentPrice - avgEntry) * currentQty;
  const openR = haveRisk ? openPnl / risk! : null;

  // lockedR is a price level in R: (stop − entry) signed for direction, over risk-per-share. LONG with
  // the stop above entry → positive (in profit); SHORT with the stop below entry → positive too.
  let lockedR: number | null = null;
  if (haveRisk && effectiveStop !== null && maxQty > EPS) {
    const dirSign = direction === "LONG" ? 1 : -1;
    const riskPerShare = risk! / maxQty;
    lockedR = ((effectiveStop - avgEntry) * dirSign) / riskPerShare;
  }

  return { openPnl, openR, lockedR };
}
