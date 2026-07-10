import { copyFileSync, existsSync } from "node:fs";

/** Copy the DB file to a timestamped backup. `stamp` is passed in (no Date.now in pure paths). */
export function backupDb(path: string, stamp: string): string | null {
  if (!existsSync(path)) return null; // nothing to back up on first run
  const dest = `${path}.backup-${stamp}`;
  copyFileSync(path, dest);
  return dest;
}
