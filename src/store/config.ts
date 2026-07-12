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
// Stored in the config table so the packaged, double-clicked app has somewhere to keep the OpenD
// WebSocket key without the user editing files / setting environment variables. Environment
// variables still WIN (resolveOpend) so a dev launch can override without touching stored state.

const OPEND_KEY = "opend";
export const DEFAULT_OPEND_PORT = 33334;

export interface StoredOpend {
  key: string | null;
  port: number | null;
}

export function getStoredOpend(db: Database): StoredOpend {
  const raw = getConfigValue(db, OPEND_KEY);
  if (!raw) return { key: null, port: null };
  const p = JSON.parse(raw) as Partial<StoredOpend>;
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

/** Effective OpenD connection: environment variable > stored config > default. Pure so it's unit
 * tested directly; empty / non-numeric env values are treated as absent. */
export function resolveOpend(
  stored: StoredOpend,
  env: { key?: string; port?: string },
): { key: string | undefined; port: number } {
  const envKey = env.key && env.key.length ? env.key : undefined;
  const key = envKey ?? stored.key ?? undefined;
  const envPortNum = env.port && env.port.length ? Number(env.port) : NaN;
  const envPort = Number.isFinite(envPortNum) ? envPortNum : undefined;
  const port = envPort ?? stored.port ?? DEFAULT_OPEND_PORT;
  return { key, port };
}
