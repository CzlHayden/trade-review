import { useTradeDetail } from "../lib/hooks";
import { money, price, rMultiple, signClass, date, dateTime, holdTime, qty } from "../lib/format";
import { FlagChips } from "../components/FlagChips";

/** Compact read-only trade detail. The marked-up candlestick chart + journal editor land in the
 * next iteration; this already shows the reconstructed trade, its fills, flags, and inferred stop. */
export function TradeDetail({ id }: { id: string }) {
  const { data, isLoading } = useTradeDetail(id);
  if (isLoading) return <div className="spinner">Loading…</div>;
  if (!data) return <div className="empty card">Trade not found.</div>;
  const { trade: t, fills, flags, stop, journal } = data;

  const stat = (label: string, value: React.ReactNode, cls = "") => (
    <div className="card kpi">
      <div className="kpi-label">{label}</div>
      <div className={`kpi-value num ${cls}`} style={{ fontSize: 16 }}>
        {value}
      </div>
    </div>
  );

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 4 }}>
        <span className="mono" style={{ fontSize: 18, fontWeight: 650 }}>
          {t.symbol}
        </span>
        <span className={t.direction === "LONG" ? "pos" : "neg"} style={{ fontWeight: 600 }}>
          {t.direction}
        </span>
        <span className="muted">
          {date(t.openTime)} → {t.closeTime ? date(t.closeTime) : "open"} · {holdTime(t.holdSeconds)}
        </span>
        {!t.coverageOk && <span className="ccy-badge">partial coverage</span>}
      </div>

      <div className="kpi-row" style={{ marginTop: 12 }}>
        {stat("Realized P&L", t.realizedPnl !== null ? money(t.realizedPnl, t.currency) : "—", signClass(t.realizedPnl))}
        {stat("R-multiple", rMultiple(t.rMultiple), signClass(t.rMultiple))}
        {stat("Risk", t.risk !== null ? price(t.risk, t.currency) : "—")}
        {stat("Avg entry / exit", `${price(t.avgEntry, t.currency)} / ${t.avgExit !== null ? price(t.avgExit, t.currency) : "—"}`)}
        {stat("Max size", qty(t.maxQty))}
        {stat("MAE / MFE", `${t.mae !== null ? money(t.mae, t.currency) : "—"} / ${t.mfe !== null ? money(t.mfe, t.currency) : "—"}`)}
      </div>

      <div className="section-title">Flags</div>
      <div className="card" style={{ padding: 12 }}>
        {flags.length === 0 ? <span className="muted">No mistake flags — clean mechanics.</span> : <FlagChips flags={flags} />}
        {flags.length > 0 && (
          <ul className="muted" style={{ margin: "10px 0 0", paddingLeft: 18, lineHeight: 1.7 }}>
            {flags.map((f) => (
              <li key={f.ruleId}>{f.reason}</li>
            ))}
          </ul>
        )}
      </div>

      <div className="section-title">Inferred stop</div>
      <div className="card" style={{ padding: 12 }}>
        {stop.receipt ? (
          <span className="mono">{stop.receipt}</span>
        ) : (
          <span className="muted">No protective stop found in orders{journal?.manualStop != null ? "" : " — add a manual stop in the journal (coming next)."}</span>
        )}
        {journal?.manualStop != null && (
          <div style={{ marginTop: 6 }}>
            Manual stop: <span className="mono">{price(journal.manualStop, t.currency)}</span>{" "}
            <span className="faint">(overrides inference)</span>
          </div>
        )}
      </div>

      <div className="section-title">Fills ({fills.length})</div>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Time</th>
              <th>Side</th>
              <th className="right">Qty</th>
              <th className="right">Price</th>
            </tr>
          </thead>
          <tbody>
            {fills.map((f) => (
              <tr key={f.id}>
                <td className="muted num">{dateTime(f.time)}</td>
                <td className={f.side === "BUY" ? "pos" : "neg"} style={{ fontWeight: 600 }}>
                  {f.side}
                </td>
                <td className="right num">{qty(f.qty)}</td>
                <td className="right num">{price(f.price, f.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
