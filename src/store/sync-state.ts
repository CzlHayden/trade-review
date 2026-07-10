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
