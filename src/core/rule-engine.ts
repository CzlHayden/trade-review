import type { Flag, RawFill, RuleConfig, RuleContext, Trade } from "../domain/types";

const EPS = 1e-9;

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
      qty += signed; // reducing — leave cost basis as-is for this simple check
    }
  }
  return false;
}

function avgRecentRisk(recent: Trade[]): number | null {
  const risks = recent.filter((t) => t.risk !== null).map((t) => t.risk as number);
  if (risks.length === 0) return null;
  return risks.reduce((a, b) => a + b, 0) / risks.length;
}

export function evaluate(trade: Trade, ctx: RuleContext, config: RuleConfig): Flag[] {
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

  // held_past_stop
  if (
    on(config, "held_past_stop") &&
    trade.effectiveStop !== null &&
    trade.mae !== null &&
    trade.mae > Math.abs(trade.avgEntry - trade.effectiveStop) + EPS
  ) {
    add("held_past_stop", "warn", "Price moved beyond your stop but the trade was still held.");
  }

  // oversized
  if (on(config, "oversized") && trade.risk !== null) {
    const avg = avgRecentRisk(ctx.recentClosedTrades);
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
