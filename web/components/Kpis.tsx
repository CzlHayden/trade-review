import type { CurrencyStats } from "../../src/domain/types";
import { money, price, pct, ratio, rMultiple, signClass } from "../lib/format";

/** Currency-segmented KPI cards. One row of cards per currency — P&L is never combined across
 * currencies (each block is self-contained). */
export function Kpis({ stats }: { stats: CurrencyStats[] }) {
  if (stats.length === 0) return <div className="empty card">No closed trades yet — run a sync.</div>;
  return (
    <div className="grid" style={{ gap: 18 }}>
      {stats.map((s) => (
        <div key={s.currency}>
          <div className="section-title" style={{ marginTop: 0 }}>
            {s.currency} · {s.tradeCount} closed
          </div>
          <div className="kpi-row">
            <Kpi label="Net P&L" value={money(s.netPnl, s.currency)} cls={signClass(s.netPnl)} />
            <Kpi label="Win rate" value={pct(s.winRate)} sub={`${Math.round(s.winRate * s.tradeCount)} of ${s.tradeCount}`} />
            <Kpi
              label="Expectancy"
              value={money(s.expectancy, s.currency)}
              cls={signClass(s.expectancy)}
              sub="per trade"
            />
            <Kpi
              label="Avg R"
              value={rMultiple(s.avgR)}
              cls={signClass(s.avgR)}
              // Avg R only covers trades with a known stop (an R basis). Disclose the population when
              // it's smaller than the closed-trade count, so it doesn't read as over all trades.
              sub={s.rCount < s.tradeCount ? `${s.rCount} of ${s.tradeCount} with a stop` : undefined}
            />
            <Kpi
              // The asymmetry itself: how big the average winner is vs the average loser, in R. A
              // "many small losses, few big wins" strategy shows a large win R next to a small loss R.
              label="Avg R · win / loss"
              value={rMultiple(s.avgWinR)}
              cls={signClass(s.avgWinR)}
              sub={`loss ${s.avgLossR !== null ? rMultiple(-s.avgLossR) : "—"}`}
            />
            <Kpi
              label="Payout ratio"
              value={ratio(s.payoutRatio)}
              sub="avg win ÷ loss (R)"
            />
            <Kpi
              // Breakeven win rate = the % of trades you'd need to win, at this payout, to net zero R.
              // Green when your actual win rate clears that bar (you have a positive edge), red when not.
              label="Breakeven win rate"
              value={s.breakevenWinRate !== null ? pct(s.breakevenWinRate) : "—"}
              cls={s.breakevenWinRate === null ? undefined : s.winRate >= s.breakevenWinRate ? "pos" : "neg"}
              sub={s.breakevenWinRate !== null ? `you win ${pct(s.winRate)}` : undefined}
            />
            <Kpi
              label="Avg win / loss"
              value={`${money(s.avgWin, s.currency)}`}
              sub={`loss ${money(-s.avgLoss, s.currency)}`}
            />
            <Kpi
              label="Avg risk / trade"
              // avgRiskPct is non-null only when avgRisk is too (a % needs a risk AND equity), so the %
              // branch can always show the dollar context. "≈" when the equity basis is approximate.
              value={
                s.avgRiskPct !== null
                  ? `${s.sizingApprox ? "≈" : ""}${pct(s.avgRiskPct)}`
                  : s.avgRisk !== null
                    ? price(s.avgRisk, s.currency)
                    : "—"
              }
              sub={
                s.avgRiskPct !== null
                  ? `of account · ≈ ${price(s.avgRisk as number, s.currency)}`
                  : s.avgRisk !== null
                    ? "per trade · sync funds for %"
                    : undefined
              }
            />
            <Kpi
              label="Avg position size"
              value={
                s.avgSizePct !== null
                  ? `${s.sizingApprox ? "≈" : ""}${pct(s.avgSizePct)}`
                  : price(s.avgPositionSize, s.currency)
              }
              sub={
                s.avgSizePct !== null
                  ? `of account · ≈ ${price(s.avgPositionSize, s.currency)}`
                  : `max ${price(s.maxPositionSize, s.currency)}`
              }
            />
            {(s.avgMae !== null || s.avgMfe !== null) && (
              <Kpi
                // MAE is the worst ADVERSE excursion — render it negative/red so it can't read as a
                // gain (money() would prefix "+"). Both are price points PER SHARE, not position $.
                label="Avg MAE / MFE"
                value={s.avgMae !== null ? money(-s.avgMae, s.currency) : "—"}
                cls={s.avgMae !== null ? signClass(-s.avgMae) : undefined}
                sub={`per share · MFE ${s.avgMfe !== null ? money(s.avgMfe, s.currency) : "—"}`}
              />
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function Kpi({ label, value, sub, cls }: { label: string; value: string; sub?: string; cls?: string }) {
  return (
    <div className="card kpi">
      <div className="kpi-label">{label}</div>
      <div className={`kpi-value num ${cls ?? ""}`}>{value}</div>
      {sub && <div className="kpi-sub num">{sub}</div>}
    </div>
  );
}
