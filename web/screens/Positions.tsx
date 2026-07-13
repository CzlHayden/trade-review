import { useLocation } from "wouter";
import { usePositions } from "../lib/hooks";
import type { OpenPosition } from "../lib/api";
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
      {rt && (rt.openRisk !== null || rt.totalPnl !== null) && (
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
            <span className="r-stat-label" title="Realized profit already banked from partial exits + unrealized on the shares still held">Portfolio P&amp;L</span>
            <span className={`r-stat-val ${signClass(rt.totalPnl)}`}>
              {rt.totalPnl !== null ? rMultiple(rt.totalPnl) : "—"}
            </span>
            <OmitCaveat
              omitted={rt.totalPnlOmitted}
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
            {g.totalPnl !== null && (
              <>
                {" · P&L "}
                <RiskFrag pct={g.totalPnlPct} amount={g.totalPnl} currency={g.currency} equityNull={g.equity === null} signed />
                {g.positionsWithoutPrice > 0 && (
                  <span className="warn" title="Excluded from this P&L total — no current price.">
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
          <div className="pos-cards">
            {g.positions.map((p) => (
              <PositionCard
                key={`${p.account}|${p.symbol}`}
                p={p}
                onOpen={p.tradeId ? () => navigate(`/trades/${encodeURIComponent(p.tradeId!)}`) : undefined}
              />
            ))}
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

/** One open position as a card: header (symbol · side · qty), avg→price + stop, the whole-trade P&L
 * ("net now") in $ and R, a banked ▸ riding bar (each piece red when it's a loss), the if-stopped
 * floor, and — only when still at risk — the stop price that would make the trade net breakeven.
 * Uniform layout across every state; clicking opens the trade. */
function PositionCard({ p, onOpen }: { p: OpenPosition; onOpen?: () => void }) {
  const ccy = p.currency;
  const long = p.qty >= 0;
  const atRisk = p.openRisk !== null && p.openRisk > 0;
  // Only surface the breakeven stop when it's an ACHIEVABLE protective stop: on the correct side of the
  // current price (below market for a long, above for a short). Otherwise "put your stop at X" would name
  // a price the market has already passed — a stop there fills immediately at a loss, not breakeven.
  const breakevenReachable =
    p.breakevenStop !== null && p.price !== null && (long ? p.breakevenStop <= p.price : p.breakevenStop >= p.price);

  const banked = p.realizedSoFar; // locked from partial exits
  const riding = p.unrealized; // paper P&L on the shares still held (null when no price)
  const bAbs = Math.abs(banked);
  const rAbs = riding === null ? 0 : Math.abs(riding);
  const total = bAbs + rAbs;
  const bWidth = total > 0 ? (bAbs / total) * 100 : 0;
  const rWidth = total > 0 ? (rAbs / total) * 100 : 0;

  return (
    <div className={`pos-card card${onOpen ? " clickable" : ""}`} onClick={onOpen}>
      <div className="pos-card-head">
        <div>
          <span className="pos-card-sym">{p.symbol}</span>
          <span className={`pos-card-side ${long ? "pos" : "neg"}`}>{long ? "LONG" : "SHORT"}</span>
          <span className="pos-card-qty">{qty(Math.abs(p.qty))}</span>
        </div>
        {p.cushion === null ? (
          <span className="risk-pill">NO STOP</span>
        ) : p.freeTrade ? (
          <span className="free-pill">FREE</span>
        ) : (
          <span className="risk-pill">AT RISK</span>
        )}
      </div>

      <div className="pos-card-sub">
        <span>
          {price(p.avgCost, ccy)}
          <span className="faint"> → </span>
          {p.price !== null ? price(p.price, ccy) : <span className="faint">—</span>}
        </span>
        <span>{p.liveStop !== null ? <>stop {price(p.liveStop, ccy)}</> : <span className="warn">no stop</span>}</span>
      </div>

      <div className="pos-card-net">
        {p.totalPnl === null ? (
          <span className="amt faint">—</span>
        ) : (
          <>
            <span className={`amt ${signClass(p.totalPnl)}`}>{money(p.totalPnl, ccy)}</span>
            <span className={`r ${signClass(p.totalPnl)}`}>{rMultiple(p.totalPnlR)}</span>
          </>
        )}
      </div>
      {p.totalPnlPct !== null && (
        <div className="pos-card-acct">{pct(p.totalPnlPct)} of acct</div>
      )}

      <div className="pos-bar">
        {bWidth > 0 && <div className={`pos-bar-seg ${banked >= 0 ? "seg-b-pos" : "seg-b-neg"}`} style={{ width: `${bWidth}%` }} />}
        {rWidth > 0 && <div className={`pos-bar-seg ${(riding ?? 0) >= 0 ? "seg-r-pos" : "seg-r-neg"}`} style={{ width: `${rWidth}%` }} />}
      </div>
      <div className="pos-legend">
        {banked !== 0 ? <span className={signClass(banked)}>banked {money(banked, ccy)}</span> : <span />}
        {riding !== null ? <span className={signClass(riding)}>riding {money(riding, ccy)}</span> : <span className="faint">no price</span>}
      </div>

      <div className="pos-floor">
        <span className="pos-floor-label">If stopped</span>
        {p.cushion === null ? (
          <span className="warn">no stop</span>
        ) : (
          <span className="pos-floor-val">
            <span className={signClass(p.cushion)}>{money(p.cushion, ccy)}</span>
            <span className={`r ${signClass(p.cushion)}`}>{rMultiple(p.cushionR)}</span>
            {p.cushionPct !== null && <span className="faint"> · {pct(p.cushionPct)} acct</span>}
          </span>
        )}
      </div>

      {atRisk && breakevenReachable && (
        <div className="pos-be">
          <span className="pos-be-label">Breakeven stop</span>
          <span className="pos-be-val">{price(p.breakevenStop!, ccy)}</span>
        </div>
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
