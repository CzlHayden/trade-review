import type { Breakdown, CurrencyStats, Stats, Trade } from "../domain/types";

/** Closed, coverage-ok trades with a realized P&L are the basis for all stats. */
function eligible(trades: Trade[]): Trade[] {
  return trades.filter((t) => t.status === "closed" && t.coverageOk && t.realizedPnl !== null);
}

function mean(xs: number[]): number | null {
  return xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function summarize(trades: Trade[]): Omit<CurrencyStats, "currency" | "equityCurve"> {
  const pnls = trades.map((t) => t.realizedPnl as number);
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p < 0);
  const netPnl = pnls.reduce((a, b) => a + b, 0);
  const winRate = trades.length === 0 ? 0 : wins.length / trades.length;
  const lossRate = trades.length === 0 ? 0 : losses.length / trades.length;
  const avgWin = wins.length === 0 ? 0 : wins.reduce((a, b) => a + b, 0) / wins.length;
  const avgLossMag =
    losses.length === 0 ? 0 : Math.abs(losses.reduce((a, b) => a + b, 0) / losses.length);
  return {
    netPnl,
    tradeCount: trades.length,
    winRate,
    avgWin,
    avgLoss: avgLossMag,
    expectancy: winRate * avgWin - lossRate * avgLossMag,
    avgR: mean(trades.filter((t) => t.rMultiple !== null).map((t) => t.rMultiple as number)),
    avgMae: mean(trades.filter((t) => t.mae !== null).map((t) => t.mae as number)),
    avgMfe: mean(trades.filter((t) => t.mfe !== null).map((t) => t.mfe as number)),
  };
}

export function computeStats(trades: Trade[]): Stats {
  const rows = eligible(trades);
  const byCurrency = new Map<string, Trade[]>();
  for (const t of rows) {
    let arr = byCurrency.get(t.currency);
    if (!arr) {
      arr = [];
      byCurrency.set(t.currency, arr);
    }
    arr.push(t);
  }

  const out: CurrencyStats[] = [];
  for (const [currency, ts] of byCurrency) {
    const sorted = ts
      .slice()
      .sort((a, b) => (a.closeTime ?? 0) - (b.closeTime ?? 0) || a.id.localeCompare(b.id));
    let cum = 0;
    const equityCurve = sorted.map((t) => {
      cum += t.realizedPnl as number;
      return { time: t.closeTime as number, cumPnl: cum };
    });
    out.push({ currency, ...summarize(ts), equityCurve });
  }
  return { byCurrency: out };
}

/** Group eligible trades by a caller key; trades whose key is null are skipped. */
export function breakdown(trades: Trade[], keyFn: (t: Trade) => string | null): Breakdown[] {
  const groups = new Map<string, Trade[]>();
  for (const t of eligible(trades)) {
    const k = keyFn(t);
    if (k === null) continue;
    let arr = groups.get(k);
    if (!arr) {
      arr = [];
      groups.set(k, arr);
    }
    arr.push(t);
  }
  const rows: Breakdown[] = [];
  for (const [key, ts] of groups) {
    const s = summarize(ts);
    rows.push({ key, netPnl: s.netPnl, tradeCount: s.tradeCount, winRate: s.winRate, avgR: s.avgR });
  }
  return rows;
}
