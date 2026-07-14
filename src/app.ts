// Single-binary bootstrap: backup → migrate → serve API + SPA shell on 127.0.0.1 → open browser.
// The compiled binary is the *program*; the DB in the user-data dir is the *save file* — updating
// the program never touches it (spec §14).
import { spawn } from "node:child_process";
import { openDb } from "./store/db";
import { runMigrations } from "./store/migrations";
import { backupDb, backupStamp } from "./store/backup";
import { dbPath, dataDir } from "./store/paths";
import { join } from "node:path";
import { getRuleConfig, getStoredOpend, opendConnection } from "./store/config";
import { cachedCandles } from "./store/candles-cache";
import { yahooCandles } from "./candles/yahoo";
import { buildApi } from "./api/routes";
import { SyncRunner } from "./api/sync-runner";
import { Mutex } from "./api/mutex";
import { runSync, rebuildDerived, type SyncResult } from "./sync/sync";
import { connectFutu } from "./futu/client";
import { checkForUpdate, type UpdateStatus } from "./api/update";
import { performInstall, consumeSilentRelaunchMarker } from "./api/self-update";
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

export async function main(): Promise<void> {
  const path = dbPath();
  backupDb(path, backupStamp()); // no-op on first run; cheap insurance now that journal data is precious
  const db = openDb(path);
  runMigrations(db);
  const config = getRuleConfig(db);
  const candles = cachedCandles(db, yahooCandles, { now: Date.now }); // live clock (long-lived server)

  // One-time local rebuild after a migration introduces a DERIVED column (v9 live_stop, v10
  // realized_so_far): those are NULL on existing trades until re-derived, and the positions view would
  // otherwise show stale live stops / zero banked profit until the first sync. Rebuild from local raw
  // data only — a no-op candle source keeps it offline and preserves prior MAE/MFE. The NULL guard runs
  // this at most once per upgrade (replaceDerived then writes a value for every trade).
  const needsBackfill = db.query(`SELECT 1 FROM trades WHERE realized_so_far IS NULL LIMIT 1`).get() != null;
  if (needsBackfill) {
    await rebuildDerived(db, { candles: { getCandles: async () => [] }, config, now: Date.now() });
  }

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
  // A compiled binary embeds the bundled SPA, so Bun.embeddedFiles is non-empty; a `bun run src/app.ts`
  // dev process has none. The released binary keeps the canonical 8123; local dev uses 8124 so both can
  // run side by side (download a release AND hack on source without a port clash). PORT overrides either.
  const runningFromSource = Bun.embeddedFiles.length === 0;
  const defaultPort = runningFromSource ? 8124 : 8123;

  // Update check, cached so navigating around doesn't hammer the GitHub API (unauth = 60 req/hr).
  // Failed checks aren't cached, so a transient outage doesn't suppress checks for hours.
  const REPO = "keithzrc/trade-review";
  const UPDATE_TTL_MS = 6 * 60 * 60_000;
  const appVersion = (pkg as { version?: string }).version ?? "0.0.0";
  // In-place update needs the compiled binary (it swaps the packaged app/exe) on a supported platform.
  // A `bun run src/app.ts` dev process has no artifact to swap, so it keeps the plain download link.
  const compiled = !runningFromSource;
  const installSupported = compiled && (process.platform === "darwin" || process.platform === "win32");
  let updateCache: { at: number; status: UpdateStatus } | null = null;
  // `force` skips the cache — the Settings "Check for updates" button uses it so a user doesn't wait
  // out the 6h TTL to see a release that landed after the app started.
  const checkUpdate = async (force = false): Promise<UpdateStatus> => {
    const nowMs = Date.now();
    if (!force && updateCache && !updateCache.status.error && nowMs - updateCache.at < UPDATE_TTL_MS) {
      return updateCache.status;
    }
    const status = await checkForUpdate({ current: appVersion, platform: process.platform, arch: process.arch, repo: REPO, installSupported });
    updateCache = { at: nowMs, status };
    return status;
  };
  // Download the new build, hand the swap off to a detached helper, then shut down so it can run. The
  // helper waits for this process to exit, replaces the app/exe, and relaunches (silently — see the
  // marker below). Returns the install result to the caller; only shuts down when it actually started.
  const reopenMarker = join(dataDir(), ".reopen-silent");
  const installUpdate = async (): Promise<{ ok: boolean; error?: string }> => {
    const status = await checkUpdate();
    const result = await performInstall({
      status,
      platform: process.platform,
      execPath: process.execPath,
      pid: process.pid,
      marker: reopenMarker,
      compiled,
    });
    if (result.ok) quit(); // deferred shutdown (the 202 flushes first); the helper then swaps + relaunches
    return result;
  };
  const api = buildApi(db, { candles, config, sync, now: Date.now, rebuildLock, quit, checkUpdate, installUpdate, appVersion });

  const server = Bun.serve({
    hostname: "127.0.0.1", // localhost bind is the entire security model (single local user)
    port: Number(process.env.PORT ?? defaultPort),
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
  // Skip opening a browser when NO_OPEN=1, or when this launch was triggered by the in-place updater
  // (the swap helper leaves a one-shot marker): the user's existing tab reloads itself onto the new
  // version, so a second tab would be noise.
  const silentRelaunch = consumeSilentRelaunchMarker(reopenMarker);
  if (process.env.NO_OPEN !== "1" && !silentRelaunch) openBrowser(openUrl);
}

if (import.meta.main) void main();
