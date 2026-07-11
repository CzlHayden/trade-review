import { usePositions } from "../lib/hooks";
import { price, money, qty, signClass } from "../lib/format";

/** Current holdings, grouped per currency (open risk is never summed across currencies). */
export function Positions() {
  const { data, isLoading } = usePositions();
  if (isLoading) return <div className="spinner">Loading…</div>;
  const groups = data?.byCurrency ?? [];
  if (groups.length === 0) return <div className="empty card">No open positions — you're flat, or haven't synced.</div>;

  return (
    <div>
      {groups.map((g) => {
        const totalRisk = g.positions.reduce((s, p) => s + (p.openRisk ?? 0), 0);
        return (
          <div key={g.currency} style={{ marginBottom: 18 }}>
            <div className="section-title" style={{ marginTop: 0 }}>
              {g.currency} · {g.positions.length} position{g.positions.length === 1 ? "" : "s"} · open risk {money(-totalRisk, g.currency)}
            </div>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th>Side</th>
                    <th className="right">Qty</th>
                    <th className="right">Avg cost</th>
                    <th className="right">Stop</th>
                    <th className="right">Open risk</th>
                  </tr>
                </thead>
                <tbody>
                  {g.positions.map((p) => (
                    <tr key={`${p.account}|${p.symbol}`}>
                      <td className="mono">{p.symbol}</td>
                      <td className={p.qty >= 0 ? "pos" : "neg"} style={{ fontWeight: 600 }}>
                        {p.qty >= 0 ? "LONG" : "SHORT"}
                      </td>
                      <td className="right num">{qty(Math.abs(p.qty))}</td>
                      <td className="right num">{price(p.avgCost, p.currency)}</td>
                      <td className="right num">{p.effectiveStop !== null ? price(p.effectiveStop, p.currency) : <span className="faint">none</span>}</td>
                      <td className={`right num ${p.openRisk ? signClass(-p.openRisk) : ""}`}>
                        {p.openRisk !== null ? money(-p.openRisk, p.currency) : <span className="faint">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
    </div>
  );
}
