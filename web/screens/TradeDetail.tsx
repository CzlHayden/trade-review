import type { ReactNode } from "react";
import { useTradeDetail, useCandles, useMeta, useTheme } from "../lib/hooks";
import { money, price, rMultiple, signClass, date, dateTime, holdTime, qty } from "../lib/format";
import { FlagChips } from "../components/FlagChips";
import { TradeChart } from "../components/TradeChart";
import { JournalEditor } from "../components/JournalEditor";

export function TradeDetail({ id }: { id: string }) {
  const { data, isLoading } = useTradeDetail(id);
  const { themeKey } = useTheme();
  const meta = useMeta();
  const t = data?.trade;
  const res: "day" | "hour" = t && t.holdSeconds !== null && t.holdSeconds < 2 * 86400 ? "hour" : "day";
  const candles = useCandles(id, res);

  if (isLoading) return <div className="spinner">Loading…</div>;
  if (!data || !t) return <div className="empty card">Trade not found.</div>;
  const { fills, flags, stop, journal } = data;

  const stat = (label: string, value: ReactNode, cls = "") => (
    <div className="card kpi">
      <div className="kpi-label">{label}</div>
      <div className={`kpi-value num ${cls}`} style={{ fontSize: 16 }}>
        {value}
      </div>
    </div>
  );

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 12 }}>
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

      <TradeChart
        candles={candles.data ?? []}
        fills={fills}
        marks={{ avgEntry: t.avgEntry, effectiveStop: t.effectiveStop, effectiveTp: t.effectiveTp, direction: t.direction }}
        themeKey={themeKey}
      />

      <div className="kpi-row" style={{ marginTop: 12 }}>
        {stat("Realized P&L", t.realizedPnl !== null ? money(t.realizedPnl, t.currency) : "—", signClass(t.realizedPnl))}
        {stat("R-multiple", rMultiple(t.rMultiple), signClass(t.rMultiple))}
        {stat("Risk", t.risk !== null ? price(t.risk, t.currency) : "—")}
        {stat("Avg entry / exit", `${price(t.avgEntry, t.currency)} / ${t.avgExit !== null ? price(t.avgExit, t.currency) : "—"}`)}
        {stat("Max size", qty(t.maxQty))}
        {stat(
          "MAE / MFE",
          `${t.mae !== null ? money(t.mae, t.currency) : "—"} / ${t.mfe !== null ? money(t.mfe, t.currency) : "—"}`,
        )}
      </div>

      <div className="grid" style={{ gridTemplateColumns: "minmax(0, 1.3fr) minmax(0, 1fr)", marginTop: 18, alignItems: "start" }}>
        <div>
          <div className="section-title" style={{ marginTop: 0 }}>
            Journal
          </div>
          <JournalEditor key={id} tradeId={id} journal={journal} setups={meta.data?.setups ?? []} currency={t.currency} />
        </div>

        <div>
          <div className="section-title" style={{ marginTop: 0 }}>
            Flags
          </div>
          <div className="card" style={{ padding: 12 }}>
            {flags.length === 0 ? (
              <span className="muted">No mistake flags — clean mechanics.</span>
            ) : (
              <>
                <FlagChips flags={flags} />
                <ul className="muted" style={{ margin: "10px 0 0", paddingLeft: 18, lineHeight: 1.7 }}>
                  {flags.map((f) => (
                    <li key={f.ruleId}>{f.reason}</li>
                  ))}
                </ul>
              </>
            )}
          </div>

          <div className="section-title">Inferred stop</div>
          <div className="card" style={{ padding: 12 }}>
            {stop.receipt ? (
              <span className="mono" style={{ fontSize: 12 }}>
                {stop.receipt}
              </span>
            ) : (
              <span className="muted">No protective stop found in orders.</span>
            )}
            {journal?.manualStop != null && (
              <div style={{ marginTop: 8 }}>
                Manual stop <span className="mono">{price(journal.manualStop, t.currency)}</span>{" "}
                <span className="faint">overrides inference</span>
              </div>
            )}
          </div>
        </div>
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
