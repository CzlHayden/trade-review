import { test, expect } from "bun:test";
import { evaluate } from "../../src/core/rule-engine";
import { buildTrades } from "../../src/core/trade-builder";
import { fill } from "../helpers";
import { DEFAULT_RULE_CONFIG, type RuleContext, type Trade } from "../../src/domain/types";

function ctx(over: Partial<RuleContext> = {}): RuleContext {
  return {
    fills: over.fills ?? [],
    recentClosedTrades: over.recentClosedTrades ?? [],
    initialStop: over.initialStop,
    stopTimeline: over.stopTimeline,
  };
}
function ids(flags: { ruleId: string }[]): string[] {
  return flags.map((f) => f.ruleId).sort();
}

test("added_to_loser: a long adds while underwater", () => {
  const fills = [
    fill("BUY", 100, 10, { time: 1000 }),
    fill("BUY", 100, 9, { time: 2000 }), // adding at 9 < avg 10 → adding to a loser
    fill("SELL", 200, 9.5, { time: 3000 }),
  ];
  const trade = buildTrades(fills)[0]!;
  const flags = evaluate(trade, ctx({ fills }), DEFAULT_RULE_CONFIG);
  expect(ids(flags)).toContain("added_to_loser");
});

test("added_to_loser: adding to a winner does NOT fire", () => {
  const fills = [
    fill("BUY", 100, 10, { time: 1000 }),
    fill("BUY", 100, 11, { time: 2000 }), // adding higher — not underwater
    fill("SELL", 200, 12, { time: 3000 }),
  ];
  const trade = buildTrades(fills)[0]!;
  const flags = evaluate(trade, ctx({ fills }), DEFAULT_RULE_CONFIG);
  expect(ids(flags)).not.toContain("added_to_loser");
});

test("cut_winner_early: closed winner under 1R", () => {
  const trade = { ...base(), realizedPnl: 50, rMultiple: 0.4 };
  expect(ids(evaluate(trade, ctx(), DEFAULT_RULE_CONFIG))).toContain("cut_winner_early");
});

test("cut_winner_early: a 2R winner does NOT fire", () => {
  const trade = { ...base(), realizedPnl: 200, rMultiple: 2 };
  expect(ids(evaluate(trade, ctx(), DEFAULT_RULE_CONFIG))).not.toContain("cut_winner_early");
});

test("held_past_stop is retired — a wick past the stop no longer flags", () => {
  // The exact NBIS shape: exited ~ −1R at the stop, MAE poked just past it. No warn flag.
  const trade = { ...base(), effectiveStop: 9, mae: 1.02, rMultiple: -1.0 };
  const flags = ids(evaluate(trade, ctx({ initialStop: 9 }), DEFAULT_RULE_CONFIG));
  expect(flags).not.toContain("held_past_stop");
  expect(flags).not.toContain("excess_loss"); // −1.0R is within plan, not excess
});

test("excess_loss: a loss materially deeper than 1R fires", () => {
  const trade = { ...base(), realizedPnl: -150, rMultiple: -1.5 };
  expect(ids(evaluate(trade, ctx({ initialStop: 9 }), DEFAULT_RULE_CONFIG))).toContain("excess_loss");
});

test("excess_loss: a clean −1R stop-out does NOT fire", () => {
  const trade = { ...base(), realizedPnl: -100, rMultiple: -1.0 };
  expect(ids(evaluate(trade, ctx({ initialStop: 9 }), DEFAULT_RULE_CONFIG))).not.toContain("excess_loss");
});

test("loosened_stop: a stop moved further from price fires", () => {
  // LONG entry 10; stop started at 9, then widened to 8 (more adverse).
  const trade = base();
  const flags = ids(evaluate(trade, ctx({ initialStop: 9, stopTimeline: [9, 8] }), DEFAULT_RULE_CONFIG));
  expect(flags).toContain("loosened_stop");
});

test("loosened_stop: trailing a stop UP (tightening) does NOT fire", () => {
  const trade = base();
  const flags = ids(evaluate(trade, ctx({ initialStop: 9, stopTimeline: [9, 9.5, 9.8] }), DEFAULT_RULE_CONFIG));
  expect(flags).not.toContain("loosened_stop");
});

test("no_stop: a trade with no protective stop fires", () => {
  const trade = base();
  expect(ids(evaluate(trade, ctx({ initialStop: null }), DEFAULT_RULE_CONFIG))).toContain("no_stop");
});

test("no_stop: a trade with a stop does NOT fire", () => {
  const trade = base();
  expect(ids(evaluate(trade, ctx({ initialStop: 9 }), DEFAULT_RULE_CONFIG))).not.toContain("no_stop");
});

test("wide_stop: a stop wider than 8% of entry fires", () => {
  // entry 10, stop 9 → 10% risk band > 8% cap.
  const trade = { ...base(), avgEntry: 10 };
  expect(ids(evaluate(trade, ctx({ initialStop: 9 }), DEFAULT_RULE_CONFIG))).toContain("wide_stop");
});

test("wide_stop: a tight stop does NOT fire", () => {
  // entry 10, stop 9.5 → 5% risk band < 8% cap.
  const trade = { ...base(), avgEntry: 10 };
  expect(ids(evaluate(trade, ctx({ initialStop: 9.5 }), DEFAULT_RULE_CONFIG))).not.toContain("wide_stop");
});

test("improper_pyramid: an add bigger than the first tranche fires", () => {
  const fills = [
    fill("BUY", 100, 10, { time: 1000 }),
    fill("BUY", 200, 10.1, { time: 2000 }), // larger add, still near the buy point
    fill("SELL", 300, 11, { time: 3000 }),
  ];
  const trade = buildTrades(fills)[0]!;
  expect(ids(evaluate(trade, ctx({ fills }), DEFAULT_RULE_CONFIG))).toContain("improper_pyramid");
});

test("improper_pyramid: a proper decreasing add near the pivot does NOT fire", () => {
  const fills = [
    fill("BUY", 100, 10, { time: 1000 }),
    fill("BUY", 50, 10.2, { time: 2000 }), // smaller add, within 5% of first entry
    fill("SELL", 150, 11, { time: 3000 }),
  ];
  const trade = buildTrades(fills)[0]!;
  expect(ids(evaluate(trade, ctx({ fills }), DEFAULT_RULE_CONFIG))).not.toContain("improper_pyramid");
});

test("overtrading_freq: too many opens within the window fires", () => {
  const day = 24 * 60 * 60_000;
  const recent = [
    { ...base(), id: "o1", openTime: 1_000_000 },
    { ...base(), id: "o2", openTime: 1_000_000 + 1000 },
    { ...base(), id: "o3", openTime: 1_000_000 + 2000 },
  ];
  const trade = { ...base(), id: "o4", openTime: 1_000_000 + 3000 }; // 4th open same day > max 3
  const flags = ids(evaluate(trade, ctx({ recentClosedTrades: recent }), DEFAULT_RULE_CONFIG));
  expect(flags).toContain("overtrading_freq");
  expect(day).toBeGreaterThan(0);
});

test("overtrading_freq: a lone trade in the window does NOT fire", () => {
  const trade = { ...base(), id: "solo", openTime: 1_000_000 };
  expect(ids(evaluate(trade, ctx(), DEFAULT_RULE_CONFIG))).not.toContain("overtrading_freq");
});

test("oversized: risk above 1.5x recent average", () => {
  const recent = [
    { ...base(), risk: 100 },
    { ...base(), risk: 100 },
  ];
  const trade = { ...base(), risk: 200 }; // 2x avg 100
  const flags = evaluate(trade, ctx({ recentClosedTrades: recent }), DEFAULT_RULE_CONFIG);
  expect(ids(flags)).toContain("oversized");
});

test("round_tripped_gain: peak >= 1R then closed red", () => {
  // risk 100, mfe 2/share * 100 qty = 200 peak gain (2R), exited at -10.
  const trade = { ...base(), risk: 100, maxQty: 100, mfe: 2, realizedPnl: -10 };
  expect(ids(evaluate(trade, ctx(), DEFAULT_RULE_CONFIG))).toContain("round_tripped_gain");
});

test("overtrading_revenge: opened soon after a losing exit", () => {
  const loser = { ...base(), id: "prior", realizedPnl: -50, closeTime: 1_000_000 };
  const trade = { ...base(), id: "current", openTime: 1_000_000 + 5 * 60_000 }; // 5 min later
  const flags = evaluate(trade, ctx({ recentClosedTrades: [loser] }), DEFAULT_RULE_CONFIG);
  expect(ids(flags)).toContain("overtrading_revenge");
});

test("overtrading_revenge: after a WINNER does not fire", () => {
  const winner = { ...base(), id: "prior", realizedPnl: 50, closeTime: 1_000_000 };
  const trade = { ...base(), id: "current", openTime: 1_000_000 + 5 * 60_000 };
  const flags = evaluate(trade, ctx({ recentClosedTrades: [winner] }), DEFAULT_RULE_CONFIG);
  expect(ids(flags)).not.toContain("overtrading_revenge");
});

test("overtrading_revenge: a trade does not flag itself", () => {
  // Same id in recentClosedTrades must be ignored (the self-exclusion guard).
  const trade = { ...base(), id: "same", realizedPnl: -50, closeTime: 1_000_000, openTime: 1_000_000 };
  const flags = evaluate(trade, ctx({ recentClosedTrades: [{ ...trade }] }), DEFAULT_RULE_CONFIG);
  expect(ids(flags)).not.toContain("overtrading_revenge");
});

test("a disabled rule never fires", () => {
  const trade = { ...base(), realizedPnl: 50, rMultiple: 0.4 };
  const cfg = { ...DEFAULT_RULE_CONFIG, enabled: { cut_winner_early: false } };
  expect(ids(evaluate(trade, ctx(), cfg))).not.toContain("cut_winner_early");
});

test("no rules fire on a coverage-incomplete (seeded) trade", () => {
  const trade = { ...base(), coverageOk: false, realizedPnl: 50, rMultiple: 0.4 };
  expect(evaluate(trade, ctx(), DEFAULT_RULE_CONFIG)).toEqual([]);
});

test("oversized ignores recent trades in a different currency", () => {
  const hkd = [
    { ...base(), id: "h1", currency: "HKD", risk: 8000 },
    { ...base(), id: "h2", currency: "HKD", risk: 8000 },
  ];
  const trade = { ...base(), currency: "USD", risk: 1500 };
  // No USD history → oversized can't fire (avg is null); HKD sizes must not suppress or trigger it.
  expect(
    ids(evaluate(trade, ctx({ recentClosedTrades: hkd }), DEFAULT_RULE_CONFIG)),
  ).not.toContain("oversized");
});

test("added_to_loser tracks cost basis correctly after a partial reduce", () => {
  const fills = [
    fill("BUY", 100, 10, { time: 1000 }),
    fill("SELL", 50, 12, { time: 2000 }), // reduce — avg cost stays 10, not 10.33
    fill("BUY", 50, 11, { time: 3000 }), // re-add at 11 → avg becomes 10.5, not a loser add
    fill("BUY", 50, 10.4, { time: 4000 }), // 10.4 < 10.5 → added to loser (missed if basis is stale)
    fill("SELL", 150, 10.5, { time: 5000 }),
  ];
  const trade = buildTrades(fills)[0]!;
  expect(ids(evaluate(trade, ctx({ fills }), DEFAULT_RULE_CONFIG))).toContain("added_to_loser");
});

// A closed LONG trade with no enrichment set; individual tests override fields.
function base(): Trade {
  return {
    id: "t",
    account: "acc1",
    symbol: "AAPL",
    currency: "USD",
    direction: "LONG",
    status: "closed",
    openTime: 1000,
    closeTime: 2000,
    avgEntry: 10,
    avgExit: 11,
    maxQty: 100,
    realizedPnl: 100,
    fees: 0,
    holdSeconds: 1,
    coverageOk: true,
    fillIds: [],
    effectiveStop: null,
    effectiveTp: null,
    risk: null,
    rMultiple: null,
    mae: null,
    mfe: null,
  };
}
