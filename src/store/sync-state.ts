import type { Database } from "bun:sqlite";
import type { SyncState } from "../domain/types";

export function getSyncState(db: Database, account: string, market: string): SyncState | null {
  const row = db
    .query(`SELECT account, market, last_synced_time, coverage_start
            FROM sync_state WHERE account = ? AND market = ?`)
    .get(account, market) as any;
  if (!row) return null;
  return {
    account: row.account,
    market: row.market,
    lastSyncedTime: row.last_synced_time ?? null,
    coverageStart: row.coverage_start ?? null,
  };
}

/** The oldest coverage_start across all (account, market) cursors — a STABLE history floor: it is
 * set on first sync and preserved thereafter (never advances). Used as the seed time for a pre-window
 * holding with no in-window fills, so that seed-only trade's deterministic id doesn't change every
 * sync (which would orphan any journal/manual stop attached to it). Null before the first sync. */
export function coverageFloor(db: Database): number | null {
  const row = db.query(`SELECT MIN(coverage_start) AS c FROM sync_state`).get() as {
    c: number | null;
  };
  return row?.c ?? null;
}

export function upsertSyncState(db: Database, s: SyncState): void {
  db.run(
    `INSERT INTO sync_state (account, market, last_synced_time, coverage_start)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(account, market) DO UPDATE SET
       last_synced_time = excluded.last_synced_time,
       coverage_start = excluded.coverage_start`,
    [s.account, s.market, s.lastSyncedTime, s.coverageStart],
  );
}
