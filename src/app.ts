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
import { serveStatic } from "./api/static";
import { SyncRunner } from "./api/sync-runner";
import { Mutex } from "./api/mutex";
import { runSync, type SyncResult } from "./sync/sync";
import { connectFutu } from "./futu/client";

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
  const api = buildApi(db, { candles, config, sync, now: Date.now, rebuildLock });

  const server = Bun.serve({
    hostname: "127.0.0.1", // localhost bind is the entire security model (single local user)
    port: Number(process.env.PORT ?? 8123),
    async fetch(req) {
      const url = new URL(req.url);
      // Include the bare "/api" so a probe there gets the API's JSON 404, not the SPA shell.
      if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return api(req);
      return (await serveStatic(req)) ?? new Response("Not found", { status: 404 });
    },
  });

  const openUrl = `http://127.0.0.1:${server.port}`;
  console.log(`Trade Review on ${openUrl}`);
  if (process.env.NO_OPEN !== "1") openBrowser(openUrl);
}

if (import.meta.main) main();
