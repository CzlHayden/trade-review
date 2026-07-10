import { test, expect } from "bun:test";
import { computeStats, breakdown } from "../../src/core/analytics";
import type { Trade } from "../../src/domain/types";

// Minimal closed-trade factory (only the fields analytics reads).
function tr(over: Partial<Trade>): Trade {
  return {
    id: over.id ?? "t",
    account: "acc1",
    symbol: over.symbol ?? "AAPL",
    currency: over.currency ?? "USD",
    direction: "LONG",
    status: "closed",
    openTime: over.openTime ?? 1000,
    closeTime: over.closeTime ?? 2000,
    avgEntry: 10,
    avgExit: 11,
    maxQty: 100,
    realizedPnl: over.realizedPnl ?? 0,
    fees: 0,
    holdSeconds: 0,
    coverageOk: over.coverageOk ?? true,
    fillIds: [],
    effectiveStop: null,
    effectiveTp: null,
    risk: null,
    rMultiple: over.rMultiple ?? null,
    mae: over.mae ?? null,
    mfe: over.mfe ?? null,
  };
}

test("segments P&L by currency; never sums across currencies", () => {
  const s = computeStats([
    tr({ currency: "USD", realizedPnl: 100 }),
    tr({ currency: "USD", realizedPnl: -40 }),
    tr({ currency: "HKD", realizedPnl: 500 }),
  ]);
  const usd = s.byCurrency.find((c) => c.currency === "USD")!;
  const hkd = s.byCurrency.find((c) => c.currency === "HKD")!;
  expect(usd.netPnl).toBe(60);
  expect(usd.tradeCount).toBe(2);
  expect(hkd.netPnl).toBe(500);
});

test("win rate, avg win/loss, expectancy", () => {
  const s = computeStats([
    tr({ realizedPnl: 200 }),
    tr({ realizedPnl: 100 }),
    tr({ realizedPnl: -100 }),
    tr({ realizedPnl: -50 }),
  ]);
  const usd = s.byCurrency[0]!;
  expect(usd.winRate).toBe(0.5);
  expect(usd.avgWin).toBe(150);
  expect(usd.avgLoss).toBe(75); // positive magnitude
  expect(usd.expectancy).toBe(0.5 * 150 - 0.5 * 75); // 37.5
});

test("avgR/avgMae/avgMfe ignore trades that lack them; null when none", () => {
  const s = computeStats([
    tr({ realizedPnl: 10, rMultiple: 2, mae: 1, mfe: 3 }),
    tr({ realizedPnl: 10, rMultiple: 4, mae: 3, mfe: 5 }),
    tr({ realizedPnl: 10 }), // no R/mae/mfe
  ]);
  const usd = s.byCurrency[0]!;
  expect(usd.avgR).toBe(3); // (2+4)/2
  expect(usd.avgMae).toBe(2);
  expect(usd.avgMfe).toBe(4);

  const none = computeStats([tr({ realizedPnl: 10 })]).byCurrency[0]!;
  expect(none.avgR).toBeNull();
});

test("excludes open and non-coverage trades", () => {
  const open = tr({ realizedPnl: 999 });
  open.status = "open";
  const s = computeStats([
    tr({ realizedPnl: 100 }),
    open,
    tr({ realizedPnl: 5, coverageOk: false }),
  ]);
  expect(s.byCurrency[0]!.tradeCount).toBe(1);
  expect(s.byCurrency[0]!.netPnl).toBe(100);
});

test("equity curve is cumulative in time order", () => {
  const s = computeStats([
    tr({ realizedPnl: 100, closeTime: 3000 }),
    tr({ realizedPnl: -30, closeTime: 1000 }),
    tr({ realizedPnl: 50, closeTime: 2000 }),
  ]);
  expect(s.byCurrency[0]!.equityCurve).toEqual([
    { time: 1000, cumPnl: -30 },
    { time: 2000, cumPnl: 20 },
    { time: 3000, cumPnl: 120 },
  ]);
});

test("empty input → no currency rows", () => {
  expect(computeStats([]).byCurrency).toEqual([]);
});

test("breakdown groups by a key function and skips null keys", () => {
  const rows = breakdown(
    [
      tr({ symbol: "AAPL", realizedPnl: 100 }),
      tr({ symbol: "AAPL", realizedPnl: -20 }),
      tr({ symbol: "TSLA", realizedPnl: 50 }),
      tr({ symbol: "SKIP", realizedPnl: 999 }),
    ],
    (t) => (t.symbol === "SKIP" ? null : t.symbol),
  );
  const aapl = rows.find((r) => r.key === "AAPL")!;
  expect(aapl.currency).toBe("USD");
  expect(aapl.netPnl).toBe(80);
  expect(aapl.tradeCount).toBe(2);
  expect(aapl.winRate).toBe(0.5);
  expect(rows.find((r) => r.key === "SKIP")).toBeUndefined();
});

test("breakdown keeps currencies separate under the same key", () => {
  const rows = breakdown(
    [
      tr({ symbol: "X", currency: "USD", realizedPnl: 100 }),
      tr({ symbol: "X", currency: "HKD", realizedPnl: 500 }),
    ],
    (t) => t.symbol,
  );
  expect(rows).toHaveLength(2);
  expect(rows.find((r) => r.currency === "USD" && r.key === "X")!.netPnl).toBe(100);
  expect(rows.find((r) => r.currency === "HKD" && r.key === "X")!.netPnl).toBe(500);
});
