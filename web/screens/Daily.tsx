import { useState, type CSSProperties } from "react";
import { useHeatmap, usePutHeatmapGroups } from "../lib/hooks";
import type { HeatmapRow } from "../lib/api";
import { dateTime } from "../lib/format";

// Per-column heat scale: the |value| at which the cell tint saturates. Tuned per horizon so a ±1%
// day reads as loud as a ±10% YTD (their natural magnitudes differ by an order of magnitude).
const SCALE = { day: 0.03, p5d: 0.06, off52w: 0.25, ytd: 0.3 };
const SYMBOL_RE = /^[A-Z]{2,6}\.[A-Z0-9.\-]{1,15}$/; // mirrors the server's validation

/** Signed percent, 2dp — the sheet-style reading ("+1.38%", "−4.03%"). */
function spct(v: number | null): string {
  if (v === null) return "—";
  const s = (v * 100).toFixed(2);
  return v > 0 ? `+${s}%` : `${s}%`;
}

/** Cell tint: green/red by sign, opacity by |value| against the column's scale. DOM styles resolve
 * our light-dark() CSS vars natively, so the tint re-themes for free. */
function heat(v: number | null, scale: number): CSSProperties {
  if (v === null) return {};
  const mag = Math.min(Math.abs(v) / scale, 1);
  const color = v >= 0 ? "var(--pos)" : "var(--neg)";
  return { background: `color-mix(in srgb, ${color} ${Math.round(mag * 40)}%, transparent)` };
}

/** "US.XLK" renders as "XLK" (the US prefix is noise in an all-ETF table); other markets keep it. */
function displaySymbol(s: string): string {
  return s.startsWith("US.") ? s.slice(3) : s;
}

/** Free-typed ticker → domain symbol: uppercase, default to the US market when no prefix given. */
function normalizeSymbol(raw: string): string {
  const s = raw.trim().toUpperCase();
  return s.includes(".") && /^[A-Z]{2,6}\./.test(s) ? s : `US.${s}`;
}

function GroupTable({
  name,
  rows,
  editing,
  onRemove,
  onAdd,
}: {
  name: string;
  rows: HeatmapRow[];
  editing: boolean;
  onRemove: (symbol: string) => void;
  onAdd: (symbol: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const draftBad = draft.trim() !== "" && !SYMBOL_RE.test(normalizeSymbol(draft));
  const commit = () => {
    if (draft.trim() === "" || draftBad) return;
    onAdd(normalizeSymbol(draft));
    setDraft("");
  };
  return (
    <div>
      <div className="section-title" style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {name}
        {editing && (
          <input
            className="input"
            style={{ fontSize: 12, padding: "2px 8px", width: 120, borderColor: draftBad ? "var(--neg)" : undefined }}
            placeholder="add: XLK, US.SPY…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
            }}
          />
        )}
      </div>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Symbol</th>
              <th className="right">Last</th>
              <th className="right" title="Latest close vs the previous session's close">% Day</th>
              <th className="right" title="Latest close vs the close 5 sessions earlier">% 5D</th>
              <th className="right" title="Latest close vs the highest intraday high of the trailing 52 weeks (0% = at highs)">
                % Off 52-wk high
              </th>
              <th className="right" title="Latest close vs the final close of the previous calendar year">% YTD</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="empty">
                  No symbols — use Edit lists to add some.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.symbol}>
                <td className="mono">
                  {displaySymbol(r.symbol)}
                  {r.last === null && (
                    <span className="ccy-badge" title="No daily candles for this symbol (unsupported market or bad ticker)">
                      no data
                    </span>
                  )}
                  {editing && (
                    <button
                      type="button"
                      className="btn btn-icon"
                      aria-label={`remove ${r.symbol}`}
                      style={{ marginLeft: 6, padding: "0 6px", fontSize: 11 }}
                      onClick={() => onRemove(r.symbol)}
                    >
                      ✕
                    </button>
                  )}
                </td>
                <td className="right num">{r.last !== null ? r.last.toFixed(2) : "—"}</td>
                <td className="right num" style={heat(r.dayPct, SCALE.day)}>{spct(r.dayPct)}</td>
                <td className="right num" style={heat(r.p5dPct, SCALE.p5d)}>{spct(r.p5dPct)}</td>
                <td className="right num" style={heat(r.off52wPct, SCALE.off52w)}>{spct(r.off52wPct)}</td>
                <td className="right num" style={heat(r.ytdPct, SCALE.ytd)}>{spct(r.ytdPct)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Daily market page: sheet-style performance heatmap for the user's ETF/sector groups (daily candles
 * from the same cached source the trade charts use). "Edit lists" toggles add/remove; every change
 * saves immediately and refetches the grid. */
export function Daily() {
  const { data, isLoading, isFetching, refetch, isError } = useHeatmap();
  const put = usePutHeatmapGroups();
  const [editing, setEditing] = useState(false);
  const [newGroup, setNewGroup] = useState("");

  if (isLoading) return <div className="spinner">Loading market data…</div>;
  if (isError || !data) return <div className="empty card">Couldn't load market data — check your connection and retry.</div>;

  // The heatmap response carries the full group composition, so edits derive the next groups payload
  // straight from what's on screen — no second query to keep in sync.
  const groups = data.groups.map((g) => ({ name: g.name, symbols: g.rows.map((r) => r.symbol) }));

  const removeSymbol = (gi: number, symbol: string) =>
    put.mutate(groups.map((g, i) => (i === gi ? { ...g, symbols: g.symbols.filter((s) => s !== symbol) } : g)));
  const addSymbol = (gi: number, symbol: string) =>
    put.mutate(groups.map((g, i) => (i === gi && !g.symbols.includes(symbol) ? { ...g, symbols: [...g.symbols, symbol] } : g)));
  const addGroup = () => {
    const name = newGroup.trim();
    if (!name || groups.some((g) => g.name === name)) return;
    setNewGroup("");
    put.mutate([...groups, { name, symbols: [] }]);
  };
  // Deleting a whole list of tickers by mis-click would be painful — only an EMPTY group is removable.
  const removeGroup = (gi: number) => {
    if (groups[gi]!.symbols.length > 0) return;
    put.mutate(groups.filter((_, i) => i !== gi));
  };

  return (
    <div>
      <div className="toolbar" style={{ marginBottom: 4, gap: 8, alignItems: "center" }}>
        <button className="btn" disabled={isFetching} onClick={() => refetch()}>
          {isFetching ? "Refreshing…" : "Refresh"}
        </button>
        <button className={`btn${editing ? " btn-primary" : ""}`} onClick={() => setEditing((e) => !e)}>
          {editing ? "Done editing" : "Edit lists"}
        </button>
        <span className="faint" style={{ fontSize: 12 }}>
          as of {dateTime(data.asOf)} · daily closes from the public candle source
        </span>
        {put.isError && <span className="neg" style={{ fontSize: 12 }}>Save failed</span>}
      </div>

      {data.groups.map((g, gi) => (
        <div key={g.name}>
          <GroupTable
            name={g.name}
            rows={g.rows}
            editing={editing}
            onRemove={(s) => removeSymbol(gi, s)}
            onAdd={(s) => addSymbol(gi, s)}
          />
          {editing && g.rows.length === 0 && (
            <button className="btn" style={{ marginTop: 6, fontSize: 11 }} onClick={() => removeGroup(gi)}>
              Remove empty group
            </button>
          )}
        </div>
      ))}

      {editing && (
        <div style={{ display: "flex", gap: 6, marginTop: 16, alignItems: "center" }}>
          <input
            className="input"
            style={{ fontSize: 12, padding: "3px 8px", width: 180 }}
            placeholder="new group name"
            value={newGroup}
            onChange={(e) => setNewGroup(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") addGroup();
            }}
          />
          <button className="btn" onClick={addGroup} disabled={!newGroup.trim()}>
            + Add group
          </button>
        </div>
      )}
    </div>
  );
}
