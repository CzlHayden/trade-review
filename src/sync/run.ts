// Real-data sync entrypoint (replaces the throwaway spike). Connects to a live OpenD, pulls the
// user's history, rebuilds derived trades/flags, and writes the local DB. Run manually:
//
//   OPEND_WS_KEY=<key> bun run src/sync/run.ts
//
// Requires OpenD running with websocket_port (default 33334) + a WebSocket Auth Key set.
import { connectFutu } from "../futu/client";
import { yahooCandles } from "../candles/yahoo";
import { runSync } from "./sync";
import { openDb } from "../store/db";
import { runMigrations } from "../store/migrations";
import { backupDb, backupStamp } from "../store/backup";
import { cachedCandles } from "../store/candles-cache";
import { getRuleConfig } from "../store/config";
import { dbPath } from "../store/paths";

async function main() {
  const path = dbPath();
  backupDb(path, backupStamp()); // no-op on first run (file doesn't exist yet)
  const db = openDb(path);
  runMigrations(db);
  const config = getRuleConfig(db);

  const key = process.env.OPEND_WS_KEY || undefined;
  const port = Number(process.env.OPEND_PORT ?? 33334);
  console.log(`Connecting to OpenD ws://127.0.0.1:${port}${key ? " (auth key set)" : ""}…`);
  const client = await connectFutu({ port, key });
  const candles = cachedCandles(db, yahooCandles, { now: Date.now });
  try {
    const res = await runSync({ db, client, candles, config, now: Date.now() });
    console.log("Sync complete:", JSON.stringify(res));
  } finally {
    client.close();
    db.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("SYNC FAILED:", e);
    process.exit(1);
  });
