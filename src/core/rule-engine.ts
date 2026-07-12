import type { Flag, RawFill, RuleConfig, RuleContext, Trade } from "../domain/types";

const EPS = 1e-9;
const DAY_MS = 24 * 60 * 60_000;

function on(config: RuleConfig, ruleId: string): boolean {
  return config.enabled[ruleId] !== false; // missing = enabled
}

/** Did the trader add to the position while it was underwater? Walk the fills. */
function addedToLoser(trade: Trade, fills: RawFill[]): boolean {
  const chrono = fills
    .slice()
    .sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
  let qty = 0; // signed
  let costQty = 0;
  let costVal = 0;
  for (const f of chrono) {
    const signed = f.side === "BUY" ? f.qty : -f.qty;
    const isAdd = qty === 0 ? true : Math.sign(signed) === Math.sign(qty);
    if (isAdd && qty !== 0) {
      const avg = costVal / costQty;
      // Long underwater when the add price is below avg cost; short when above.
      if (trade.direction === "LONG" ? f.price < avg - EPS : f.price > avg + EPS) return true;
    }
    if (isAdd) {
      costQty += f.qty;
      costVal += f.qty * f.price;
      qty += signed;
    } else {
      // reducing — remove shares at the running average cost (avg is unchanged),
      // so a later re-add is compared against the correct basis.
      if (costQty > EPS) {
        const avg = costVal / costQty;
        costQty -= f.qty;
        costVal -= avg * f.qty;
      }
      qty += signed;
    }
  }
  return false;
}

/** Did the trader pyramid the wrong way? O'Neil: add only in DECREASING size and near the buy point.
 * Fires if any add is larger than the opening tranche, or priced more than `extendedPct` past the
 * first entry (too extended). Walks fills; only adds on the position's own side count. */
function improperPyramid(trade: Trade, fills: RawFill[], extendedPct: number): boolean {
  const chrono = fills
    .slice()
    .sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
  let qty = 0; // signed
  let firstQty = 0;
  let firstPrice = 0;
  for (const f of chrono) {
    const signed = f.side === "BUY" ? f.qty : -f.qty;
    const isAdd = qty === 0 ? true : Math.sign(signed) === Math.sign(qty);
    if (qty === 0) {
      firstQty = f.qty;
      firstPrice = f.price;
    } else if (isAdd) {
      if (f.qty > firstQty + EPS) return true; // add bigger than the initial tranche
      const tooExtended =
        trade.direction === "LONG"
          ? f.price > firstPrice * (1 + extendedPct) + EPS
          : f.price < firstPrice * (1 - extendedPct) - EPS;
      if (tooExtended) return true;
    }
    qty += signed;
  }
  return false;
}

/** Was a protective stop moved FURTHER from price (loosened) over the trade's life? For a long a
 * loosening is a later trigger below an earlier one; for a short, above. Trailing a stop toward
 * price (tightening) is good behavior and never fires. */
function loosenedStop(trade: Trade, timeline: number[]): boolean {
  if (timeline.length < 2) return false;
  if (trade.direction === "LONG") {
    let tightest = timeline[0] as number; // highest trigger seen so far
    for (const t of timeline.slice(1)) {
      if (t < tightest - EPS) return true;
      if (t > tightest) tightest = t;
    }
  } else {
    let tightest = timeline[0] as number; // lowest trigger seen so far
    for (const t of timeline.slice(1)) {
      if (t > tightest + EPS) return true;
      if (t < tightest) tightest = t;
    }
  }
  return false;
}

/** Average risk of recent closed trades IN THE SAME CURRENCY (never mix HKD and USD sizes). */
function avgRecentRisk(recent: Trade[], currency: string): number | null {
  const risks = recent
    .filter((t) => t.currency === currency && t.risk !== null)
    .map((t) => t.risk as number);
  if (risks.length === 0) return null;
  return risks.reduce((a, b) => a + b, 0) / risks.length;
}

export function evaluate(trade: Trade, ctx: RuleContext, config: RuleConfig): Flag[] {
  // Seeded trades have incomplete fill history; their enrichment is approximate, so — like
  // analytics — we don't run rules on them (avoids false flags on partial data).
  if (!trade.coverageOk) return [];

  const flags: Flag[] = [];
  const add = (ruleId: string, severity: "info" | "warn", reason: string) => {
    if (on(config, ruleId)) flags.push({ ruleId, severity, reason });
  };

  // added_to_loser
  if (on(config, "added_to_loser") && addedToLoser(trade, ctx.fills)) {
    add("added_to_loser", "warn", "Increased size while the position was underwater.");
  }

  // cut_winner_early
  if (
    on(config, "cut_winner_early") &&
    trade.status === "closed" &&
    trade.realizedPnl !== null &&
    trade.realizedPnl > 0 &&
    trade.rMultiple !== null &&
    trade.rMultiple < config.cutWinnerR
  ) {
    add(
      "cut_winner_early",
      "info",
      `Exited a winner for ${trade.rMultiple.toFixed(2)}R (< ${config.cutWinnerR}R).`,
    );
  }

  // excess_loss — realized loss deeper than the plan (gap, slippage, or a stop not honored).
  if (
    on(config, "excess_loss") &&
    trade.status === "closed" &&
    trade.rMultiple !== null &&
    trade.rMultiple < -config.excessLossR - EPS
  ) {
    add(
      "excess_loss",
      "warn",
      `Loss reached ${trade.rMultiple.toFixed(2)}R — deeper than your planned 1R.`,
    );
  }

  // no_stop — no protective stop / risk basis was ever found for the trade.
  if (on(config, "no_stop") && (ctx.initialStop === null || ctx.initialStop === undefined)) {
    add("no_stop", "warn", "No protective stop order was found for this trade.");
  }

  // wide_stop — the planned stop sits further than the max-loss cap below entry.
  if (
    on(config, "wide_stop") &&
    ctx.initialStop !== null &&
    ctx.initialStop !== undefined &&
    trade.avgEntry > EPS
  ) {
    const stopPct = Math.abs(trade.avgEntry - ctx.initialStop) / trade.avgEntry;
    if (stopPct > config.maxStopPct + EPS) {
      add("wide_stop", "warn", `Initial stop was ${(stopPct * 100).toFixed(1)}% from entry (cap ${(config.maxStopPct * 100).toFixed(0)}%).`);
    }
  }

  // loosened_stop — a protective stop was moved further from price during the trade.
  if (on(config, "loosened_stop") && ctx.stopTimeline !== undefined && loosenedStop(trade, ctx.stopTimeline)) {
    add("loosened_stop", "warn", "You moved a protective stop further from price.");
  }

  // improper_pyramid — added in increasing size, or too far past the initial buy point.
  if (on(config, "improper_pyramid") && improperPyramid(trade, ctx.fills, config.pyramidExtendedPct)) {
    add("improper_pyramid", "info", "Pyramided in increasing size or well past your initial entry.");
  }

  // overtrading_freq — more new positions opened in the window than the churn threshold.
  if (on(config, "overtrading_freq")) {
    const windowMs = config.overtradeWindowDays * DAY_MS;
    const opensInWindow =
      1 + // this trade
      ctx.recentClosedTrades.filter(
        (p) =>
          p.id !== trade.id &&
          trade.openTime - p.openTime >= 0 &&
          trade.openTime - p.openTime <= windowMs,
      ).length;
    if (opensInWindow > config.overtradeMaxOpens) {
      add(
        "overtrading_freq",
        "info",
        `${opensInWindow} positions opened within ${config.overtradeWindowDays} day(s).`,
      );
    }
  }

  // oversized
  if (on(config, "oversized") && trade.risk !== null) {
    const avg = avgRecentRisk(ctx.recentClosedTrades, trade.currency);
    if (avg !== null && avg > EPS && trade.risk > config.oversizedMult * avg) {
      add(
        "oversized",
        "warn",
        `Risk was ${(trade.risk / avg).toFixed(1)}x your recent average.`,
      );
    }
  }

  // round_tripped_gain
  if (
    on(config, "round_tripped_gain") &&
    trade.status === "closed" &&
    trade.realizedPnl !== null &&
    trade.realizedPnl <= 0 &&
    trade.mfe !== null &&
    trade.risk !== null &&
    trade.risk > EPS &&
    trade.mfe * trade.maxQty >= config.roundTripR * trade.risk
  ) {
    add("round_tripped_gain", "info", "Gave back a gain that reached your target and closed flat/red.");
  }

  // overtrading_revenge
  if (on(config, "overtrading_revenge")) {
    const windowMs = config.revengeMinutes * 60_000;
    const revenge = ctx.recentClosedTrades.some(
      (p) =>
        p.id !== trade.id && // never let a trade flag itself
        p.realizedPnl !== null &&
        p.realizedPnl < 0 &&
        p.closeTime !== null &&
        trade.openTime - p.closeTime >= 0 &&
        trade.openTime - p.closeTime <= windowMs,
    );
    if (revenge) {
      add(
        "overtrading_revenge",
        "warn",
        `Opened within ${config.revengeMinutes} min of closing a losing trade.`,
      );
    }
  }

  return flags;
}
