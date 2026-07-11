import { useState } from "react";
import { useBreakdowns } from "../lib/hooks";
import { money, pct, rMultiple, signClass } from "../lib/format";

const DIMS = [
  { key: "setup", label: "Setup" },
  { key: "tag", label: "Tag" },
  { key: "symbol", label: "Symbol" },
  { key: "holdBucket", label: "Hold time" },
];

/** "Find my edge" breakdown — grouped per (currency, key). Never sums across currencies. */
export function BreakdownTable() {
  const [by, setBy] = useState("setup");
  const { data, isLoading } = useBreakdowns(by);
  // Group by currency, then rank by net P&L within each currency — never compare magnitudes across currencies.
  const rows = (data ?? []).slice().sort((a, b) => (a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : b.netPnl - a.netPnl));
  // Bar width normalizes within a currency only: a HKD row must not be scaled against a USD peak.
  const maxAbsByCcy = new Map<string, number>();
  for (const r of rows) maxAbsByCcy.set(r.currency, Math.max(maxAbsByCcy.get(r.currency) ?? 1, Math.abs(r.netPnl)));

  return (
    <div>
      <div className="toolbar" style={{ marginBottom: 8 }}>
        {DIMS.map((d) => (
          <button
            key={d.key}
            className={`btn${by === d.key ? " btn-primary" : ""}`}
            onClick={() => setBy(d.key)}
          >
            {d.label}
          </button>
        ))}
      </div>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>{DIMS.find((d) => d.key === by)?.label}</th>
              <th className="right">Net P&L</th>
              <th className="right">Trades</th>
              <th className="right">Win</th>
              <th className="right">Avg R</th>
              <th style={{ width: 110 }} />
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td colSpan={6} className="spinner">
                  Loading…
                </td>
              </tr>
            )}
            {!isLoading && rows.length === 0 && (
              <tr>
                <td colSpan={6} className="empty">
                  No {by} data yet — add setups/tags in the trade journal.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={`${r.currency}|${r.key}`}>
                <td>
                  {r.key}
                  <span className="ccy-badge">{r.currency}</span>
                </td>
                <td className={`right num ${signClass(r.netPnl)}`}>{money(r.netPnl, r.currency)}</td>
                <td className="right num muted">{r.tradeCount}</td>
                <td className="right num muted">{pct(r.winRate)}</td>
                <td className={`right num ${signClass(r.avgR)}`}>{rMultiple(r.avgR)}</td>
                <td>
                  <div className="bar">
                    <span
                      style={{
                        width: `${(Math.abs(r.netPnl) / (maxAbsByCcy.get(r.currency) ?? 1)) * 100}%`,
                        background: r.netPnl >= 0 ? "var(--pos)" : "var(--neg)",
                      }}
                    />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
