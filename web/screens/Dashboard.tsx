import { useStats, useTrades, useTheme } from "../lib/hooks";
import { Kpis } from "../components/Kpis";
import { EquityChart } from "../components/EquityChart";
import { BreakdownTable } from "../components/BreakdownTable";
import { TradesTable } from "../components/TradesTable";

export function Dashboard() {
  const stats = useStats();
  const trades = useTrades();
  const [mode] = useTheme();

  const byCurrency = stats.data?.byCurrency ?? [];
  const flagged = (trades.data ?? []).filter((t) => t.flags.length > 0);

  return (
    <div>
      {stats.isLoading ? (
        <div className="spinner">Loading…</div>
      ) : (
        <Kpis stats={byCurrency} />
      )}

      {byCurrency.some((c) => c.equityCurve.length > 1) && (
        <>
          <div className="section-title">Equity curve</div>
          <div className="grid" style={{ gridTemplateColumns: byCurrency.length > 1 ? "1fr 1fr" : "1fr" }}>
            {byCurrency
              .filter((c) => c.equityCurve.length > 1)
              .map((c) => (
                <div className="card" key={c.currency} style={{ padding: "10px 12px" }}>
                  <div className="kpi-label" style={{ marginBottom: 4 }}>
                    {c.currency}
                  </div>
                  <EquityChart
                    themeKey={mode}
                    points={c.equityCurve.map((p) => ({ time: p.time, value: p.cumPnl }))}
                  />
                </div>
              ))}
          </div>
        </>
      )}

      <div className="section-title">Find my edge</div>
      <BreakdownTable />

      <div className="section-title">Flagged trades ({flagged.length})</div>
      {trades.isLoading ? (
        <div className="spinner">Loading…</div>
      ) : flagged.length === 0 ? (
        <div className="empty card">No flags — clean mechanics, or no trades yet.</div>
      ) : (
        <TradesTable rows={flagged} />
      )}
    </div>
  );
}
