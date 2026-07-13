// Single-binary bootstrap: backup → migrate → serve API + SPA shell on 127.0.0.1 → open browser.
// The compiled binary is the *program*; the DB in the user-data dir is the *save file* — updating
// the program never touches it (spec §14).
import { spawn } from "node:child_process";
import { openDb } from "./store/db";
import { runMigrations } from "./store/migrations";
import { backupDb, backupStamp } from "./store/backup";
import { dbPath } from "./store/paths";
import { getRuleConfig, getStoredOpend, opendConnection } from "./store/config";
import { cachedCandles } from "./store/candles-cache";
import { yahooCandles } from "./candles/yahoo";
import { buildApi } from "./api/routes";
import { SyncRunner } from "./api/sync-runner";
import { Mutex } from "./api/mutex";
import { runSync, backfillLiveStops, type SyncResult } from "./sync/sync";
import { connectFutu } from "./futu/client";
import { checkForUpdate, type UpdateStatus } from "./api/update";
import pkg from "../package.json";
// Bun fullstack HTML import: Bun bundles the referenced React/TS/CSS in dev (with HMR) and EMBEDS the
// built assets under `bun build --compile`. This is what replaces a separate Vite toolchain.
import index from "../web/index.html";

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    const child = spawn(cmd, [url], {
      stdio: "ignore",
      detached: true,
      shell: process.platform === "win32",
    });
    // A missing opener (e.g. headless Linux with no xdg-open) emits an ASYNC 'error' event after
    // spawn returns — the try/catch can't see it, and an unhandled 'error' would crash the process.
    child.on("error", () => {}); // best-effort: the URL is printed to the console regardless
    child.unref();
  } catch {
    // best-effort: the URL is printed to the console regardless
  }
}

export function main(): void {
  const path = dbPath();
  backupDb(path, backupStamp()); // no-op on first run; cheap insurance now that journal data is precious
  const db = openDb(path);
  runMigrations(db);
  // After migrating, populate the v9 `live_stop` column for existing open trades so the positions
  // view shows correct protection immediately — before (and without needing) the first OpenD sync.
  backfillLiveStops(db);
  const config = getRuleConfig(db);
  const candles = cachedCandles(db, yahooCandles, { now: Date.now }); // live clock (long-lived server)

  // Shared by the sync job and journal-triggered rebuilds so the two rebuilds never interleave.
  const rebuildLock = new Mutex();
  // The sync job holds the OpenD socket only for its own duration. Only the derived rebuild is
  // serialized (rebuildGuard) — the network pull runs unlocked, so a journal edit never blocks
  // behind slow/unreachable OpenD.
  const syncJob = async (): Promise<SyncResult> => {
    // Read fresh each sync so a key saved in Settings takes effect without a restart.
    const { key, port } = opendConnection(getStoredOpend(db));
    const client = await connectFutu({ port, key });
    try {
      return await runSync({
        db,
        client,
        candles,
        config,
        now: Date.now(),
        rebuildGuard: (fn) => rebuildLock.runExclusive(fn),
      });
    } finally {
      client.close();
    }
  };
  const sync = new SyncRunner(db, syncJob, Date.now);
  // Graceful shutdown for the in-app Quit button. Deferred a beat so the 202 flushes to the browser
  // before we stop serving; then close the DB and exit. `server` is assigned just below (closure).
  const quit = () => {
    console.log("Quit requested — shutting down.");
    setTimeout(() => {
      try {
        server.stop(true); // close in-flight connections
        db.close();
      } finally {
        process.exit(0);
      }
    }, 150);
  };
  // Notify-only update check, cached so navigating around doesn't hammer the GitHub API (unauth = 60
  // req/hr). Failed checks aren't cached, so a transient outage doesn't suppress checks for hours.
  const REPO = "keithzrc/trade-review";
  const UPDATE_TTL_MS = 6 * 60 * 60_000;
  const appVersion = (pkg as { version?: string }).version ?? "0.0.0";
  let updateCache: { at: number; status: UpdateStatus } | null = null;
  const checkUpdate = async (): Promise<UpdateStatus> => {
    const nowMs = Date.now();
    if (updateCache && !updateCache.status.error && nowMs - updateCache.at < UPDATE_TTL_MS) {
      return updateCache.status;
    }
    const status = await checkForUpdate({ current: appVersion, platform: process.platform, arch: process.arch, repo: REPO });
    updateCache = { at: nowMs, status };
    return status;
  };
  const api = buildApi(db, { candles, config, sync, now: Date.now, rebuildLock, quit, checkUpdate });

  const server = Bun.serve({
    hostname: "127.0.0.1", // localhost bind is the entire security model (single local user)
    port: Number(process.env.PORT ?? 8123),
    development: process.env.NODE_ENV !== "production", // HMR + rich errors for `bun run`; off in the binary
    routes: {
      // Most-specific first: API paths hit the JSON handler; everything else serves the bundled SPA
      // (index.html), which is the SPA's own history-mode fallback.
      "/api/*": (req) => api(req),
      "/api": (req) => api(req),
      "/*": index,
    },
  });

  const openUrl = `http://127.0.0.1:${server.port}`;
  console.log(`Trade Review on ${openUrl}`);
  if (process.env.NO_OPEN !== "1") openBrowser(openUrl);
}

if (import.meta.main) main();
