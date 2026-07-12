// Single-binary bootstrap: backup → migrate → serve API + SPA shell on 127.0.0.1 → open browser.
// The compiled binary is the *program*; the DB in the user-data dir is the *save file* — updating
// the program never touches it (spec §14).
import { spawn } from "node:child_process";
import { openDb } from "./store/db";
import { runMigrations } from "./store/migrations";
import { backupDb, backupStamp } from "./store/backup";
import { dbPath } from "./store/paths";
import { getRuleConfig } from "./store/config";
import { cachedCandles } from "./store/candles-cache";
import { yahooCandles } from "./candles/yahoo";
import { buildApi } from "./api/routes";
import { SyncRunner } from "./api/sync-runner";
import { Mutex } from "./api/mutex";
import { runSync, type SyncResult } from "./sync/sync";
import { connectFutu } from "./futu/client";
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
  const config = getRuleConfig(db);
  const candles = cachedCandles(db, yahooCandles, { now: Date.now }); // live clock (long-lived server)

  // Shared by the sync job and journal-triggered rebuilds so the two rebuilds never interleave.
  const rebuildLock = new Mutex();
  // The sync job holds the OpenD socket only for its own duration. Only the derived rebuild is
  // serialized (rebuildGuard) — the network pull runs unlocked, so a journal edit never blocks
  // behind slow/unreachable OpenD.
  const syncJob = async (): Promise<SyncResult> => {
    const key = process.env.OPEND_WS_KEY || undefined;
    const port = Number(process.env.OPEND_PORT ?? 33334);
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
  const api = buildApi(db, { candles, config, sync, now: Date.now, rebuildLock, quit });

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
