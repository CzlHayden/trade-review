import { useState } from "react";
import type { Journal } from "../lib/api";
import { usePutJournal } from "../lib/hooks";

type Form = {
  thesis: string;
  emotion: string;
  conviction: number;
  rating: number;
  notes: string;
  manualStop: string;
  setup: string;
  tags: string[];
};

const EMPTY: Form = { thesis: "", emotion: "", conviction: 0, rating: 0, notes: "", manualStop: "", setup: "", tags: [] };

function fromJournal(j: Journal | null): Form {
  if (!j) return { ...EMPTY, tags: [] };
  return {
    thesis: j.thesis ?? "",
    emotion: j.emotion ?? "",
    conviction: j.conviction ?? 0,
    rating: j.rating ?? 0,
    notes: j.notes ?? "",
    manualStop: j.manualStop != null ? String(j.manualStop) : "",
    setup: j.setup ?? "",
    tags: [...j.tags],
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

/** Clickable suggestions for a single-value field: pick a previously-used value with one click (click
 * the active one again to clear). Nothing shown when there's no history yet. */
function PickChips({ options, active, onPick }: { options: string[]; active: string; onPick: (v: string) => void }) {
  if (options.length === 0) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 5 }}>
      {options.map((o) => (
        <button
          key={o}
          type="button"
          className={`btn${active === o ? " btn-primary" : ""}`}
          style={{ padding: "1px 8px", fontSize: 11 }}
          onClick={() => onPick(active === o ? "" : o)}
        >
          {o}
        </button>
      ))}
    </div>
  );
}

export function JournalEditor({
  tradeId,
  journal,
  setups,
  emotions,
  allTags,
  currency,
}: {
  tradeId: string;
  journal: Journal | null;
  setups: string[];
  emotions: string[];
  allTags: string[];
  currency: string;
}) {
  const [form, setForm] = useState(() => fromJournal(journal));
  const [tagDraft, setTagDraft] = useState("");
  const [key] = useState(tradeId); // reset form only when the trade changes (via remount below)
  const save = usePutJournal(tradeId);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));

  const addTag = (raw: string) => {
    const t = raw.trim();
    setTagDraft("");
    if (!t) return;
    setForm((f) => (f.tags.includes(t) ? f : { ...f, tags: [...f.tags, t] }));
  };
  const removeTag = (t: string) => setForm((f) => ({ ...f, tags: f.tags.filter((x) => x !== t) }));

  const submit = () => {
    const trimmedStop = form.manualStop.trim();
    // Fold in any tag still sitting in the draft box (user typed one and hit Save without pressing Enter).
    const draft = tagDraft.trim();
    const tags = draft && !form.tags.includes(draft) ? [...form.tags, draft] : form.tags;
    if (draft) {
      setForm((f) => (f.tags.includes(draft) ? f : { ...f, tags: [...f.tags, draft] }));
      setTagDraft("");
    }
    save.mutate({
      thesis: form.thesis || null,
      emotion: form.emotion.trim() || null,
      conviction: form.conviction || null,
      rating: form.rating || null,
      notes: form.notes || null,
      manualStop: trimmedStop === "" ? null : Number(trimmedStop),
      setup: form.setup.trim() || null,
      tags,
    });
  };

  // Reject any non-finite value (NaN, Infinity, 1e999) — a non-finite number JSON-serializes to null
  // and would silently CLEAR the authoritative manual stop with a 200.
  const stopInvalid = form.manualStop.trim() !== "" && !Number.isFinite(Number(form.manualStop));
  const tagSuggestions = allTags.filter((t) => !form.tags.includes(t));

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
        <div style={{ flex: "1 1 180px" }}>
          <label className="kpi-label">Emotion</label>
          <input className="input" list="emotions" style={{ width: "100%", minWidth: 0, marginTop: 3 }} value={form.emotion}
            onChange={(e) => set("emotion", e.target.value)} placeholder="calm, FOMO…" />
          <datalist id="emotions">
            {emotions.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
          <PickChips options={emotions} active={form.emotion.trim()} onPick={(v) => set("emotion", v)} />
        </div>
        <div style={{ flex: "1 1 180px" }}>
          <label className="kpi-label">Setup</label>
          <input className="input" list="setups" style={{ width: "100%", minWidth: 0, marginTop: 3 }} value={form.setup}
            onChange={(e) => set("setup", e.target.value)} placeholder="breakout, pullback…" />
          <datalist id="setups">
            {setups.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
          <PickChips options={setups} active={form.setup.trim()} onPick={(v) => set("setup", v)} />
        </div>
        <div style={{ flex: "1 1 130px" }}>
          <label className="kpi-label">Manual stop ({currency})</label>
          <input className="input" style={{ width: "100%", minWidth: 0, marginTop: 3, borderColor: stopInvalid ? "var(--neg)" : undefined }}
            value={form.manualStop} onChange={(e) => set("manualStop", e.target.value)} placeholder="overrides inferred" inputMode="decimal" />
        </div>
      </div>

      <div>
        <label className="kpi-label">Tags</label>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 3, alignItems: "center" }}>
          {form.tags.map((t) => (
            <span key={t} className="tag" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              {t}
              <button
                type="button"
                aria-label={`remove ${t}`}
                onClick={() => removeTag(t)}
                style={{ background: "none", border: "none", color: "inherit", cursor: "pointer", padding: 0, fontSize: 13, lineHeight: 1 }}
              >
                ×
              </button>
            </span>
          ))}
          <input
            className="input"
            list="alltags"
            style={{ flex: "1 1 120px", minWidth: 100 }}
            value={tagDraft}
            onChange={(e) => setTagDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === ",") {
                e.preventDefault();
                addTag(tagDraft);
              } else if (e.key === "Backspace" && tagDraft === "" && form.tags.length > 0) {
                removeTag(form.tags[form.tags.length - 1]!); // backspace on an empty box pops the last chip
              }
            }}
            // No onBlur auto-commit: committing a chip on blur re-wraps the row and can shift the Save
            // button between mousedown and mouseup, swallowing the click. Enter/comma commit, and submit()
            // folds any uncommitted draft, so nothing is lost.
            placeholder="type to add, Enter to commit…"
          />
          <datalist id="alltags">
            {allTags.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </div>
        {tagSuggestions.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 5 }}>
            {tagSuggestions.map((t) => (
              <button key={t} type="button" className="btn" style={{ padding: "1px 8px", fontSize: 11 }} onClick={() => addTag(t)}>
                + {t}
              </button>
            ))}
          </div>
        )}
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
