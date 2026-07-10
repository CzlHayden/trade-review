import { test, expect } from "bun:test";
import { evaluate } from "../../src/core/rule-engine";
import { buildTrades } from "../../src/core/trade-builder";
import { fill } from "../helpers";
import { DEFAULT_RULE_CONFIG, type RuleContext, type Trade } from "../../src/domain/types";

function ctx(over: Partial<RuleContext> = {}): RuleContext {
  return {
    fills: over.fills ?? [],
    candles: over.candles ?? [],
    resolution: over.resolution ?? 60_000,
    recentClosedTrades: over.recentClosedTrades ?? [],
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

test("held_past_stop: adverse excursion beyond the stop distance", () => {
  // entry 10, stop 9 → stop distance 1; mae 1.5 → went past the stop.
  const trade = { ...base(), effectiveStop: 9, mae: 1.5 };
  expect(ids(evaluate(trade, ctx(), DEFAULT_RULE_CONFIG))).toContain("held_past_stop");
});

test("held_past_stop: mae within the stop does NOT fire", () => {
  const trade = { ...base(), effectiveStop: 9, mae: 0.5 };
  expect(ids(evaluate(trade, ctx(), DEFAULT_RULE_CONFIG))).not.toContain("held_past_stop");
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
  const loser = { ...base(), realizedPnl: -50, closeTime: 1_000_000 };
  const trade = { ...base(), openTime: 1_000_000 + 5 * 60_000 }; // 5 min later
  const flags = evaluate(trade, ctx({ recentClosedTrades: [loser] }), DEFAULT_RULE_CONFIG);
  expect(ids(flags)).toContain("overtrading_revenge");
});

test("overtrading_revenge: after a WINNER does not fire", () => {
  const winner = { ...base(), realizedPnl: 50, closeTime: 1_000_000 };
  const trade = { ...base(), openTime: 1_000_000 + 5 * 60_000 };
  const flags = evaluate(trade, ctx({ recentClosedTrades: [winner] }), DEFAULT_RULE_CONFIG);
  expect(ids(flags)).not.toContain("overtrading_revenge");
});

test("a disabled rule never fires", () => {
  const trade = { ...base(), realizedPnl: 50, rMultiple: 0.4 };
  const cfg = { ...DEFAULT_RULE_CONFIG, enabled: { cut_winner_early: false } };
  expect(ids(evaluate(trade, ctx(), cfg))).not.toContain("cut_winner_early");
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
