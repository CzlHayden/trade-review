import { useLocation } from "wouter";
import { usePositions } from "../lib/hooks";
import { price, money, pct, qty, rMultiple, signClass } from "../lib/format";

/** Current holdings, grouped per currency. The framing is R-first: "if I'm stopped at my current
 * stop, what happens?" — so a stop above entry reads as locked profit / a free trade, not risk.
 * Dollars are never summed across currencies; R (dimensionless) is, in the portfolio strip. */
export function Positions() {
  const { data, isLoading } = usePositions();
  const [, navigate] = useLocation();
  if (isLoading) return <div className="spinner">Loading…</div>;
  const groups = data?.byCurrency ?? [];
  if (groups.length === 0) return <div className="empty card">No open positions — you're flat, or haven't synced.</div>;

  const rt = data?.rTotals;

  return (
    <div>
      {rt && (rt.openRisk !== null || rt.unrealized !== null) && (
        <div className="r-strip">
          <div className="r-stat">
            <span className="r-stat-label">Portfolio open risk</span>
            <span className={`r-stat-val ${rt.openRisk ? "neg" : ""}`}>
              {rt.openRisk !== null ? rMultiple(-rt.openRisk) : "—"}
            </span>
            <OmitCaveat
              omitted={rt.openRiskOmitted}
              label={rt.unprotected === rt.openRiskOmitted ? "with no stop" : "not counted"}
              title={
                rt.unprotected === rt.openRiskOmitted
                  ? "These positions have no working stop — their risk is real but unquantified, so it is NOT in the figure above."
                  : "Excluded from this total — no working stop, or no 1R basis to express the risk in R."
              }
            />
          </div>
          <div className="r-stat">
            <span className="r-stat-label">Open P&amp;L</span>
            <span className={`r-stat-val ${signClass(rt.unrealized)}`}>
              {rt.unrealized !== null ? rMultiple(rt.unrealized) : "—"}
            </span>
            <OmitCaveat
              omitted={rt.unrealizedOmitted}
              label="not counted"
              title="Excluded from this P&L total — no current price, or no 1R basis to express it in R."
            />
          </div>
        </div>
      )}

      {groups.map((g) => (
        <div key={g.currency} style={{ marginBottom: 20 }}>
          <div className="section-title" style={{ marginTop: 0 }}>
            {g.currency} · {g.positions.length} position{g.positions.length === 1 ? "" : "s"}
            {" · open risk "}
            <RiskFrag pct={g.riskPct} amount={g.totalOpenRisk} currency={g.currency} equityNull={g.equity === null} negative />
            {g.positionsWithoutStop > 0 && (
              <span className="warn" title="Excluded from this open-risk total — no working stop, so the risk can't be quantified.">
                {" "}(+{g.positionsWithoutStop} no stop)
              </span>
            )}
            {g.totalUnrealized !== null && (
              <>
                {" · open P&L "}
                <RiskFrag pct={g.unrealizedPct} amount={g.totalUnrealized} currency={g.currency} equityNull={g.equity === null} signed />
                {g.positionsWithoutPrice > 0 && (
                  <span className="warn" title="Excluded from this open-P&L total — no current price.">
                    {" "}(+{g.positionsWithoutPrice} no price)
                  </span>
                )}
              </>
            )}
            {" · deployed "}
            {g.deployedPct !== null ? (
              <>{pct(g.deployedPct)} <span className="faint">({price(g.deployed, g.currency)})</span></>
            ) : (
              price(g.deployed, g.currency)
            )}
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>Side</th>
                  <th className="right">Qty</th>
                  <th className="right">Avg → Price</th>
                  <th className="right">Stop</th>
                  <th className="right">If stopped</th>
                  <th className="right">Open P&amp;L</th>
                </tr>
              </thead>
              <tbody>
                {g.positions.map((p) => (
                  <tr
                    key={`${p.account}|${p.symbol}`}
                    className={p.tradeId ? "clickable" : ""}
                    onClick={p.tradeId ? () => navigate(`/trades/${encodeURIComponent(p.tradeId!)}`) : undefined}
                  >
                    <td className="mono">{p.symbol}</td>
                    <td className={p.qty >= 0 ? "pos" : "neg"} style={{ fontWeight: 600, fontSize: 11 }}>
                      {p.qty >= 0 ? "LONG" : "SHORT"}
                    </td>
                    <td className="right num">{qty(Math.abs(p.qty))}</td>
                    <td className="right num">
                      {price(p.avgCost, p.currency)}
                      <span className="faint"> → </span>
                      {p.price !== null ? price(p.price, p.currency) : <span className="faint">—</span>}
                    </td>
                    <td className="right num">
                      {p.liveStop !== null ? price(p.liveStop, p.currency) : <span className="warn">no stop</span>}
                    </td>
                    {/* If stopped now: signed R (− at risk / + locked), the $ beneath, the % of account
                        below that, and a FREE pill. */}
                    <td className="right num">
                      {p.stopOutcome === null ? (
                        <span className="faint">—</span>
                      ) : (
                        <RCell r={p.stopOutcomeR} amount={p.stopOutcome} pct={p.stopOutcomePct} currency={p.currency} badge={p.freeTrade ? "FREE" : undefined} />
                      )}
                    </td>
                    <td className="right num">
                      {p.unrealized === null ? (
                        <span className="faint">—</span>
                      ) : (
                        <RCell r={p.unrealizedR} amount={p.unrealized} pct={p.unrealizedPct} currency={p.currency} />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Caveat under an R total: "+N …" when the total silently omits positions it can't quantify, so a
 * partial figure never reads as the whole book. Renders nothing when nothing was omitted. */
function OmitCaveat({ omitted, label, title }: { omitted: number; label: string; title: string }) {
  if (omitted <= 0) return null;
  return (
    <span className="r-stat-caveat warn" title={title}>
      + {omitted} {label}
    </span>
  );
}

/** A signed R value (primary) with the dollar amount beneath and, when known, the % of account below
 * that — leading with R, then $, then % (sizing preference). Colored by sign. Optional pill (FREE). */
function RCell({ r, amount, pct: p, currency, badge }: { r: number | null; amount: number; pct?: number | null; currency: string; badge?: string }) {
  const cls = signClass(r ?? amount);
  return (
    <div style={{ display: "inline-flex", flexDirection: "column", alignItems: "flex-end", gap: 1 }}>
      <span className={cls} style={{ fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 6 }}>
        {badge && <span className="free-pill">{badge}</span>}
        {r !== null ? rMultiple(r) : money(amount, currency)}
      </span>
      {r !== null && <span className="faint" style={{ fontSize: 11 }}>{money(amount, currency)}</span>}
      {p !== null && p !== undefined && (
        <span className="faint" style={{ fontSize: 11 }} title="Share of account equity (this currency)">
          {pct(p)} of acct
        </span>
      )}
    </div>
  );
}

/** Header fragment: "X% of equity ($…)" — or just the amount when equity is unknown. `negative` shows
 * a loss (open risk) as a negative dollar figure; `signed` colors by sign (open P&L). */
function RiskFrag({ pct: p, amount, currency, equityNull, negative, signed }: {
  pct: number | null; amount: number | null; currency: string; equityNull: boolean; negative?: boolean; signed?: boolean;
}) {
  if (amount === null) return <span className="faint">—</span>;
  const dollars = negative ? -amount : amount;
  const cls = signed ? signClass(amount) : negative && amount > 0 ? "neg" : "";
  const money$ = <span className={cls}>{money(dollars, currency)}</span>;
  if (p !== null) return <>{pct(p)} of equity <span className="faint">({money$})</span></>;
  return <>{money$}{equityNull && <span className="faint" title="No account-equity snapshot yet — run a sync"> · equity n/a</span>}</>;
}
