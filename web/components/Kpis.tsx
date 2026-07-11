import type { CurrencyStats } from "../../src/domain/types";
import { money, pct, rMultiple, signClass } from "../lib/format";

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
            <Kpi label="Avg R" value={rMultiple(s.avgR)} cls={signClass(s.avgR)} />
            <Kpi
              label="Avg win / loss"
              value={`${money(s.avgWin, s.currency)}`}
              sub={`loss ${money(-s.avgLoss, s.currency)}`}
            />
            {(s.avgMae !== null || s.avgMfe !== null) && (
              <Kpi
                label="Avg MAE / MFE"
                value={s.avgMae !== null ? money(s.avgMae, s.currency) : "—"}
                sub={`MFE ${s.avgMfe !== null ? money(s.avgMfe, s.currency) : "—"}`}
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
