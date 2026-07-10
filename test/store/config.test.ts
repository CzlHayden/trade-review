import { test, expect } from "bun:test";
import { openTestDb } from "../helpers";
import { getRuleConfig, setRuleConfig } from "../../src/store/config";
import { DEFAULT_RULE_CONFIG } from "../../src/domain/types";

test("getRuleConfig returns defaults when nothing is stored", () => {
  const db = openTestDb();
  expect(getRuleConfig(db)).toEqual(DEFAULT_RULE_CONFIG);
});

test("setRuleConfig persists and getRuleConfig reads it back", () => {
  const db = openTestDb();
  const cfg = { ...DEFAULT_RULE_CONFIG, oversizedMult: 2, enabled: { cut_winner_early: false } };
  setRuleConfig(db, cfg);
  expect(getRuleConfig(db)).toEqual(cfg);
});

test("getRuleConfig merges stored overrides onto defaults (new default keys survive)", () => {
  const db = openTestDb();
  // Simulate an older stored config missing a field that later became a default.
  db.run("INSERT INTO config (key, value) VALUES ('rules', ?)", [
    JSON.stringify({ oversizedMult: 3 }),
  ]);
  const cfg = getRuleConfig(db);
  expect(cfg.oversizedMult).toBe(3); // stored override wins
  expect(cfg.cutWinnerR).toBe(DEFAULT_RULE_CONFIG.cutWinnerR); // absent → default
  expect(cfg.enabled).toEqual({}); // absent → default
});

test("default config is a fresh copy — mutating it never corrupts module defaults", () => {
  const db = openTestDb();
  const cfg = getRuleConfig(db); // no stored row → defaults
  cfg.enabled.cut_winner_early = false; // caller mutates before saving
  // A second fresh read must be unaffected by the mutation above.
  expect(getRuleConfig(db).enabled).toEqual({});
  expect(DEFAULT_RULE_CONFIG.enabled).toEqual({});
});

test("setRuleConfig overwrites the previous value (single row)", () => {
  const db = openTestDb();
  setRuleConfig(db, { ...DEFAULT_RULE_CONFIG, roundTripR: 2 });
  setRuleConfig(db, { ...DEFAULT_RULE_CONFIG, roundTripR: 5 });
  expect(getRuleConfig(db).roundTripR).toBe(5);
  const count = db.query("SELECT COUNT(*) AS n FROM config WHERE key='rules'").get() as { n: number };
  expect(count.n).toBe(1);
});
