import { useMemo, useState } from "react";
import { useTrades, useMeta } from "../lib/hooks";
import { TradesTable } from "../components/TradesTable";

export function Trades() {
  const trades = useTrades();
  const meta = useMeta();
  const [q, setQ] = useState("");
  const [flag, setFlag] = useState("");
  const [setup, setSetup] = useState("");
  const [ccy, setCcy] = useState("");

  const allFlags = useMemo(() => {
    const s = new Set<string>();
    for (const t of trades.data ?? []) for (const f of t.flags) s.add(f.ruleId);
    return [...s].sort();
  }, [trades.data]);

  const rows = useMemo(() => {
    const needle = q.trim().toUpperCase();
    return (trades.data ?? []).filter((t) => {
      if (needle && !t.symbol.toUpperCase().includes(needle)) return false;
      if (flag && !t.flags.some((f) => f.ruleId === flag)) return false;
      if (setup && t.setup !== setup) return false;
      if (ccy && t.currency !== ccy) return false;
      return true;
    });
  }, [trades.data, q, flag, setup, ccy]);

  return (
    <div>
      <div className="toolbar">
        <input
          className="input"
          placeholder="Search symbol…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select className="select" value={ccy} onChange={(e) => setCcy(e.target.value)}>
          <option value="">All currencies</option>
          {(meta.data?.currencies ?? []).map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <select className="select" value={flag} onChange={(e) => setFlag(e.target.value)}>
          <option value="">All flags</option>
          {allFlags.map((f) => (
            <option key={f} value={f}>
              {f.replace(/_/g, " ")}
            </option>
          ))}
        </select>
        <select className="select" value={setup} onChange={(e) => setSetup(e.target.value)}>
          <option value="">All setups</option>
          {(meta.data?.setups ?? []).map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <span className="muted num" style={{ marginLeft: "auto" }}>
          {rows.length} trade{rows.length === 1 ? "" : "s"}
        </span>
      </div>
      {trades.isLoading ? <div className="spinner">Loading…</div> : <TradesTable rows={rows} />}
    </div>
  );
}
