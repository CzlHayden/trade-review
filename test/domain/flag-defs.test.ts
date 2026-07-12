import { test, expect } from "bun:test";
import {
  FLAG_DEFS,
  flagDef,
  FLAG_CATEGORY_ORDER,
  FLAG_CATEGORY_LABEL,
} from "../../src/domain/flag-defs";

const EXPECTED_IDS = [
  "added_to_loser",
  "cut_winner_early",
  "oversized",
  "round_tripped_gain",
  "overtrading_revenge",
  "excess_loss",
  "no_stop",
  "wide_stop",
  "improper_pyramid",
  "overtrading_freq",
] as const;

const CATEGORIES = new Set(["stop-risk", "sizing", "entry", "exit", "timing", "hygiene"]);
const KINDS = new Set(["behavior", "outcome", "context", "hygiene"]);

test("every known rule has a complete definition", () => {
  for (const id of EXPECTED_IDS) {
    const def = FLAG_DEFS[id];
    expect(def, `missing FlagDef for ${id}`).toBeDefined();
    expect(def!.id).toBe(id);
    expect(def!.title.length).toBeGreaterThan(0);
    expect(def!.summary.length).toBeGreaterThan(0);
    expect(def!.why.length).toBeGreaterThan(0);
    expect(CATEGORIES.has(def!.category)).toBe(true);
    expect(KINDS.has(def!.kind)).toBe(true);
    expect(def!.defaultSeverity === "info" || def!.defaultSeverity === "warn").toBe(true);
  }
});

test("every category used by a flag has an order slot and a label", () => {
  for (const def of Object.values(FLAG_DEFS)) {
    expect(FLAG_CATEGORY_ORDER).toContain(def.category);
    expect(FLAG_CATEGORY_LABEL[def.category].length).toBeGreaterThan(0);
  }
});

test("the retired held_past_stop rule is not in the registry", () => {
  expect(FLAG_DEFS["held_past_stop"]).toBeUndefined();
});

test("flagDef falls back to a humanized title for an unknown id", () => {
  const def = flagDef("some_new_rule");
  expect(def.title).toBe("Some new rule");
  expect(def.id).toBe("some_new_rule");
});
