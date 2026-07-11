import { useState } from "react";
import type { Journal } from "../lib/api";
import { usePutJournal } from "../lib/hooks";

const EMPTY = { thesis: "", emotion: "", conviction: 0, rating: 0, notes: "", manualStop: "", setup: "", tags: "" };

function fromJournal(j: Journal | null) {
  if (!j) return { ...EMPTY };
  return {
    thesis: j.thesis ?? "",
    emotion: j.emotion ?? "",
    conviction: j.conviction ?? 0,
    rating: j.rating ?? 0,
    notes: j.notes ?? "",
    manualStop: j.manualStop != null ? String(j.manualStop) : "",
    setup: j.setup ?? "",
    tags: j.tags.join(", "),
  };
}

/** 1–5 segmented picker; 0 = unset. */
function Score({ value, onChange, label }: { value: number; onChange: (n: number) => void; label: string }) {
  return (
    <div>
      <label className="kpi-label">{label}</label>
      <div style={{ display: "flex", gap: 4, marginTop: 3 }}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            className={`btn${value === n ? " btn-primary" : ""}`}
            style={{ padding: "3px 9px", minWidth: 30 }}
            onClick={() => onChange(value === n ? 0 : n)}
          >
            {n}
          </button>
        ))}
      </div>
    </div>
  );
}

export function JournalEditor({
  tradeId,
  journal,
  setups,
  currency,
}: {
  tradeId: string;
  journal: Journal | null;
  setups: string[];
  currency: string;
}) {
  const [form, setForm] = useState(() => fromJournal(journal));
  const [key] = useState(tradeId); // reset form only when the trade changes (via remount below)
  const save = usePutJournal(tradeId);

  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  const submit = () => {
    const trimmedStop = form.manualStop.trim();
    save.mutate({
      thesis: form.thesis || null,
      emotion: form.emotion || null,
      conviction: form.conviction || null,
      rating: form.rating || null,
      notes: form.notes || null,
      manualStop: trimmedStop === "" ? null : Number(trimmedStop),
      setup: form.setup.trim() || null,
      tags: form.tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
    });
  };

  // Reject any non-finite value (NaN, Infinity, 1e999) — a non-finite number JSON-serializes to null
  // and would silently CLEAR the authoritative manual stop with a 200.
  const stopInvalid = form.manualStop.trim() !== "" && !Number.isFinite(Number(form.manualStop));

  return (
    <div className="card" style={{ padding: 14, display: "flex", flexDirection: "column", gap: 12 }} data-key={key}>
      <div>
        <label className="kpi-label">Thesis</label>
        <textarea className="input" style={{ width: "100%", minHeight: 46, marginTop: 3, resize: "vertical" }}
          value={form.thesis} onChange={(e) => set("thesis", e.target.value)} placeholder="Why did you take this trade?" />
      </div>

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
        <Score label="Conviction" value={form.conviction} onChange={(n) => set("conviction", n)} />
        <Score label="Rating (execution)" value={form.rating} onChange={(n) => set("rating", n)} />
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 130px" }}>
          <label className="kpi-label">Emotion</label>
          <input className="input" style={{ width: "100%", minWidth: 0, marginTop: 3 }} value={form.emotion}
            onChange={(e) => set("emotion", e.target.value)} placeholder="calm, FOMO…" />
        </div>
        <div style={{ flex: "1 1 130px" }}>
          <label className="kpi-label">Setup</label>
          <input className="input" list="setups" style={{ width: "100%", minWidth: 0, marginTop: 3 }} value={form.setup}
            onChange={(e) => set("setup", e.target.value)} placeholder="breakout, pullback…" />
          <datalist id="setups">
            {setups.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </div>
        <div style={{ flex: "1 1 130px" }}>
          <label className="kpi-label">Manual stop ({currency})</label>
          <input className="input" style={{ width: "100%", minWidth: 0, marginTop: 3, borderColor: stopInvalid ? "var(--neg)" : undefined }}
            value={form.manualStop} onChange={(e) => set("manualStop", e.target.value)} placeholder="overrides inferred" inputMode="decimal" />
        </div>
      </div>

      <div>
        <label className="kpi-label">Tags (comma-separated)</label>
        <input className="input" style={{ width: "100%", marginTop: 3 }} value={form.tags}
          onChange={(e) => set("tags", e.target.value)} placeholder="earnings, revenge, A+…" />
      </div>

      <div>
        <label className="kpi-label">Notes</label>
        <textarea className="input" style={{ width: "100%", minHeight: 70, marginTop: 3, resize: "vertical" }}
          value={form.notes} onChange={(e) => set("notes", e.target.value)} placeholder="Markdown notes…" />
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <button className="btn btn-primary" disabled={save.isPending || stopInvalid} onClick={submit}>
          {save.isPending ? "Saving…" : "Save journal"}
        </button>
        {save.isSuccess && !save.isPending && <span className="pos" style={{ fontSize: 12 }}>Saved ✓</span>}
        {save.isError && <span className="neg" style={{ fontSize: 12 }}>Save failed</span>}
        {stopInvalid && <span className="neg" style={{ fontSize: 12 }}>Manual stop must be a number</span>}
      </div>
    </div>
  );
}
