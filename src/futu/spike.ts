// Throwaway spike. Deleted once the real futu-client (Plan 4) exists.
// Proves: futu-api connects to OpenD and returns account + historical fill data,
// both under `bun run` and under a `bun build --compile` binary.
//
// KEY FACT: futu-api (the official npm/JS SDK) is a WebSocket-only client (see
// node_modules/futu-api/base.js: it opens `new WebSocket("ws://host:port")` -
// there is no raw-TCP code path). It must connect to OpenD's *websocket_port*
// (33334 here), NOT the native protobuf-over-TCP api_port (33333). See the
// spec's "Spike Result" section for the full connectivity story + field names.
import ftWebsocket from "futu-api";

const HOST = "127.0.0.1";
// 33334 = OpenD's websocket_port. 33333 is the native TCP api_port (unusable by
// this SDK). Override with OPEND_PORT if the port changes.
const PORT = Number(process.env.OPEND_PORT ?? 33334);
// Optional plaintext WebSocket auth key; SDK MD5-hashes it internally before
// sending. Blank/undefined when OpenD's auth key is not configured.
const KEY = process.env.OPEND_WS_KEY || undefined;

// TrdEnv_Real = 1 (Trd_Common.proto)
const TRD_ENV_REAL = 1;

function ninetyDaysAgo(): string {
  const d = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} 00:00:00`;
}

function now(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} 23:59:59`;
}

async function main() {
  const ws = new ftWebsocket();

  await new Promise<void>((resolve, reject) => {
    ws.onlogin = (ok: boolean, msg: unknown) =>
      ok ? resolve() : reject(new Error(`OpenD login failed: ${JSON.stringify(msg)}`));
    // start(ip, port, enableSSL, key?) - no SSL; pass auth key if configured.
    ws.start(HOST, PORT, false, KEY);
  });
  console.log(`Connected to OpenD (ws://${HOST}:${PORT}${KEY ? ", auth key set" : ", no auth key"}).`);

  // 1) List trading accounts: Trd_GetAccList (cmd 2001)
  const accListResp: any = await ws.GetAccList({
    c2s: { userID: 0 },
  });
  console.log("=== Trd_GetAccList response (raw) ===");
  console.log(JSON.stringify(accListResp, null, 2));

  const accList = accListResp?.s2c?.accList ?? [];
  console.log(`Found ${accList.length} trading account(s).`);
  if (accList.length === 0) {
    console.log("No accounts returned; nothing further to query. Exiting.");
    ws.stop();
    return;
  }

  const firstAcc = accList[0];
  console.log("First account (raw):", JSON.stringify(firstAcc, null, 2));

  const accID = firstAcc.accID;
  const trdMarket = firstAcc.trdMarketAuthList?.[0] ?? 1; // fall back to TrdMarket_HK

  // 2) Historical fills: Trd_GetHistoryOrderFillList (cmd 2222), last ~90 days
  const fillsResp: any = await ws.GetHistoryOrderFillList({
    c2s: {
      header: {
        trdEnv: TRD_ENV_REAL,
        accID,
        trdMarket,
      },
      filterConditions: {
        beginTime: ninetyDaysAgo(),
        endTime: now(),
      },
    },
  });
  console.log("=== Trd_GetHistoryOrderFillList response (raw) ===");
  console.log(JSON.stringify(fillsResp, null, 2));

  const fills = fillsResp?.s2c?.orderFillList ?? [];
  console.log(`Found ${fills.length} historical fill(s) in the last ~90 days.`);
  console.log("First few fills:", JSON.stringify(fills.slice(0, 5), null, 2));

  ws.stop();
  console.log("SPIKE SUCCESS: connected, listed accounts, queried historical fills.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("SPIKE FAILED:", e);
    process.exit(1);
  });
