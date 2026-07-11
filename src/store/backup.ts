import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";

/** A filesystem-safe local timestamp ("YYYYMMDD-HHMMSS") for backup filenames. */
export function backupStamp(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * Create a consistent backup copy of the DB via `VACUUM INTO`. Unlike a plain file copy,
 * this captures data still living in the WAL (write-ahead log), so a pre-migration backup
 * taken while the DB is in use never silently drops recent writes. `stamp` is passed in
 * (callers own the timestamp — this stays deterministic-friendly).
 */
export function backupDb(path: string, stamp: string): string | null {
  if (!existsSync(path)) return null; // nothing to back up on first run
  const dest = `${path}.backup-${stamp}`;
  const db = new Database(path);
  try {
    db.run("VACUUM INTO ?", [dest]);
  } finally {
    db.close();
  }
  return dest;
}
