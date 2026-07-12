import type { Database } from "bun:sqlite";
import { DEFAULT_RULE_CONFIG, type RuleConfig } from "../domain/types";

const RULES_KEY = "rules";

/** Read the rule config, shallow-merging any stored overrides onto the current defaults so a
 * config written by an older version still gains newly-added default fields. */
export function getRuleConfig(db: Database): RuleConfig {
  const row = db.query("SELECT value FROM config WHERE key = ?").get(RULES_KEY) as
    | { value: string }
    | null;
  if (!row) return { ...DEFAULT_RULE_CONFIG, enabled: { ...DEFAULT_RULE_CONFIG.enabled } };
  const stored = JSON.parse(row.value) as Partial<RuleConfig>;
  return {
    ...DEFAULT_RULE_CONFIG,
    ...stored,
    enabled: { ...DEFAULT_RULE_CONFIG.enabled, ...(stored.enabled ?? {}) },
  };
}

export function setRuleConfig(db: Database, config: RuleConfig): void {
  db.run(
    `INSERT INTO config (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [RULES_KEY, JSON.stringify(config)],
  );
}

// ---- generic config KV --------------------------------------------------------

/** Marker for the timestamp of the most recent position-snapshot batch (written by pullRaw). It is
 * the reconciliation clock for seed derivation and the "current holdings" batch — NOT wall-clock
 * time. Using it (instead of `now`) lets a standalone rebuild reconcile against the last real
 * snapshot, and lets an all-flat sync correctly report zero open positions. */
export const LAST_SNAPSHOT_TIME = "last_snapshot_time";

export function getConfigValue(db: Database, key: string): string | null {
  const row = db.query("SELECT value FROM config WHERE key = ?").get(key) as
    | { value: string }
    | null;
  return row?.value ?? null;
}

export function setConfigValue(db: Database, key: string, value: string): void {
  db.run(
    `INSERT INTO config (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, value],
  );
}

// ---- OpenD connection (key + port) --------------------------------------------
// The single source of truth is the config table (set via the Settings screen) — so the packaged,
// double-clicked app is configured entirely in-app, with no environment variables or file editing.

const OPEND_KEY = "opend";
export const DEFAULT_OPEND_PORT = 33334;

export interface StoredOpend {
  key: string | null;
  port: number | null;
}

export function getStoredOpend(db: Database): StoredOpend {
  const raw = getConfigValue(db, OPEND_KEY);
  if (!raw) return { key: null, port: null };
  // Degrade to "nothing stored" on a malformed/legacy row rather than throwing — otherwise a corrupt
  // value would 500 the Settings GET *and* PUT (setStoredOpend reads first, so even the repair path
  // dies) and throw on every sync. Self-healing: the next successful PUT overwrites the bad row.
  let p: Partial<StoredOpend> | null;
  try {
    p = JSON.parse(raw) as Partial<StoredOpend>;
  } catch {
    p = null;
  }
  if (p === null || typeof p !== "object") return { key: null, port: null };
  return {
    key: typeof p.key === "string" ? p.key : null,
    port: typeof p.port === "number" ? p.port : null,
  };
}

/** Merge a partial patch onto the stored value — an undefined field is left unchanged (so saving the
 * port alone never wipes a previously-saved key). */
export function setStoredOpend(db: Database, patch: Partial<StoredOpend>): void {
  const cur = getStoredOpend(db);
  const next: StoredOpend = {
    key: patch.key !== undefined ? patch.key : cur.key,
    port: patch.port !== undefined ? patch.port : cur.port,
  };
  setConfigValue(db, OPEND_KEY, JSON.stringify(next));
}

/** The connection to hand OpenD: the stored key (undefined when unset) and the stored port (falling
 * back to the default). Pure, so it's unit tested directly. */
export function opendConnection(stored: StoredOpend): { key: string | undefined; port: number } {
  return { key: stored.key ?? undefined, port: stored.port ?? DEFAULT_OPEND_PORT };
}
