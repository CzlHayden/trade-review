import { useMemo, type ReactNode } from "react";
import { useTradeDetail, useCandles, useMeta, useTheme } from "../lib/hooks";
import { money, price, pct, rMultiple, signClass, date, dateTime, holdTime, qty } from "../lib/format";
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
  // Stable marks identity so background refetches don't rerun the chart effect (which calls fitContent
  // and would reset the user's zoom/pan). Keyed on the primitive fields the chart actually draws.
  const marks = useMemo(
    () => ({ avgEntry: t?.avgEntry ?? 0, effectiveStop: t?.effectiveStop ?? null, effectiveTp: t?.effectiveTp ?? null, direction: t?.direction ?? "LONG" }),
    [t?.avgEntry, t?.effectiveStop, t?.effectiveTp, t?.direction],
  );

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
        {!t.coverageOk && (
          <span
            className="ccy-badge"
            title="This position predates our data coverage or shows a share-count change without matching fills (possible split/corporate action). Excluded from stats; risk/R not computed and P&L may be approximate."
          >
            possible corporate action
          </span>
        )}
      </div>

      <TradeChart
        candles={candles.data ?? []}
        fills={fills}
        marks={marks}
        themeKey={themeKey}
      />

      <div className="kpi-row" style={{ marginTop: 12 }}>
        {stat("Realized P&L", t.realizedPnl !== null ? money(t.realizedPnl, t.currency) : "—", signClass(t.realizedPnl))}
        {stat("R-multiple", rMultiple(t.rMultiple), signClass(t.rMultiple))}
        {stat(
          "Planned risk",
          <>
            {t.risk !== null ? price(t.risk, t.currency) : "—"}
            {data.riskPct !== null && (
              <span className="faint" style={{ fontSize: 12 }}>
                {" · "}
                {data.equityBasis === "latest" ? "≈" : ""}
                {pct(data.riskPct)} of acct
              </span>
            )}
          </>,
        )}
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

          <div className="section-title">Stops &amp; risk basis</div>
          <div className="card" style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10, fontSize: 12 }}>
            {(() => {
              // R/risk is computed from the PLANNED stop (manual override, else the initial inferred
              // stop) — NOT the effective/trailing stop shown below. Surface both so R is reconcilable.
              const plannedStop = journal?.manualStop ?? stop.initialStop;
              const profitSide =
                plannedStop != null &&
                (t.direction === "LONG" ? plannedStop > t.avgEntry : plannedStop < t.avgEntry);
              return (
                <>
                  <div>
                    <div className="kpi-label">Planned stop {journal?.manualStop != null ? "(manual)" : ""} · risk basis</div>
                    {plannedStop != null ? (
                      <span className="mono">{price(plannedStop, t.currency)}</span>
                    ) : (
                      <span className="muted">none — R not computed</span>
                    )}
                    {plannedStop != null && t.risk !== null && (
                      <div className="faint mono" style={{ marginTop: 2 }}>
                        |{price(t.avgEntry, t.currency)} − {price(plannedStop, t.currency)}| × {qty(t.maxQty)} = {price(t.risk, t.currency)}
                      </div>
                    )}
                    {plannedStop != null && t.risk === null && (
                      <div className="faint" style={{ marginTop: 2 }}>
                        {profitSide
                          ? "Risk not computed — this stop is on the profit side of entry (e.g. a split-affected or un-adjusted price)."
                          : "Risk not computed — seeded/corporate-action trade. Enter a Manual stop above to set the risk basis and get your R."}
                      </div>
                    )}
                  </div>
                  <div>
                    <div className="kpi-label">Effective stop (last active)</div>
                    {stop.receipt ? (
                      <span className="mono">{stop.receipt}</span>
                    ) : (
                      <span className="muted">No protective stop found in orders.</span>
                    )}
                  </div>
                </>
              );
            })()}
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
