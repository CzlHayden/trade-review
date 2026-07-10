import { homedir } from "node:os";
import { join } from "node:path";

/** Stable per-user data directory. DB lives here, never next to the binary. */
export function dataDir(): string {
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "TradeReview");
  }
  if (process.platform === "win32") {
    return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "TradeReview");
  }
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "TradeReview");
}

export function dbPath(dir: string = dataDir()): string {
  return join(dir, "trade-review.sqlite");
}
