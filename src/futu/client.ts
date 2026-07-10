// Live FutuClient over OpenD's WebSocket (futu-api). Read-only: it never places/modifies orders.
// All response shaping is delegated to the pure mappers in map.ts, which the tests cover; this
// file is the thin socket adapter, verified manually against a running OpenD (see src/sync/run.ts).
//
// Connectivity facts (from the spike, spec "Spike Result"): connect to OpenD's websocket_port
// (33334), NOT the native TCP api_port (33333). ftWebsocket is a default export; the SDK
// MD5-hashes the plaintext auth key internally, so pass the plaintext key as the 4th start() arg.
import ftWebsocket from "futu-api";
import type { Account, FutuClient } from "../domain/ports";
import type { RawFill, RawOrder, RawPosition } from "../domain/types";
import { isCancelledFill, mapAccount, mapFill, mapOrder, mapPosition, TRD_ENV_REAL } from "./map";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** FUTU history filters want local-time "YYYY-MM-DD HH:MM:SS" strings. */
function fmtFutu(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export interface ConnectOpts {
  host?: string;
  port?: number;
  key?: string;
  paceMs?: number; // delay before each history/position call to respect FUTU rate limits
  connectTimeoutMs?: number; // fail the connect if OpenD never logs us in (default 10s)
}

export async function connectFutu(opts: ConnectOpts = {}): Promise<FutuClient> {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 33334;
  const key = opts.key;
  const paceMs = opts.paceMs ?? 350;
  const connectTimeoutMs = opts.connectTimeoutMs ?? 10_000;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ws: any = new ftWebsocket();

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    // If OpenD isn't listening, onlogin never fires and futu-api just keeps reconnecting — without
    // this timeout the CLI would hang forever instead of surfacing SYNC FAILED.
    const timer = setTimeout(
      () =>
        done(() =>
          reject(new Error(`OpenD connection timed out after ${connectTimeoutMs}ms — is OpenD running on ws://${host}:${port}?`)),
        ),
      connectTimeoutMs,
    );
    ws.onlogin = (ok: boolean, msg: unknown) =>
      done(() => (ok ? resolve() : reject(new Error(`OpenD login failed: ${JSON.stringify(msg)}`))));
    ws.start(host, port, false, key); // (ip, port, ssl=false, plaintext key)
    // Best-effort fast-fail on an abnormal socket error/close before login (down / wrong port).
    // These are the user-hook seams on the base socket (base.js forwards to them); safe to set and
    // guarded by `settled` so they never fire after a successful login.
    if (ws.websock) {
      ws.websock.onerror = () => done(() => reject(new Error(`OpenD socket error (ws://${host}:${port})`)));
      ws.websock.onclose = () => done(() => reject(new Error(`OpenD socket closed before login (ws://${host}:${port})`)));
    }
  });

  // Preserve the raw SDK account object (its accID is a uint64 we must echo back verbatim rather
  // than round-trip through String, which could lose precision on large ids).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawById = new Map<string, any>();

  function header(account: Account, market: number) {
    const raw = rawById.get(account.id);
    return { trdEnv: account.trdEnv ?? TRD_ENV_REAL, accID: raw?.accID ?? account.id, trdMarket: market };
  }

  return {
    async getAccounts(): Promise<Account[]> {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const resp: any = await ws.GetAccList({ c2s: { userID: 0 } });
      const list = resp?.s2c?.accList ?? [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return list.map((a: any) => {
        const acc = mapAccount(a);
        rawById.set(acc.id, a);
        return acc;
      });
    },

    async getHistoryFills(account, market, beginMs, endMs): Promise<RawFill[]> {
      await sleep(paceMs);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const resp: any = await ws.GetHistoryOrderFillList({
        c2s: { header: header(account, market), filterConditions: { beginTime: fmtFutu(beginMs), endTime: fmtFutu(endMs) } },
      });
      return (resp?.s2c?.orderFillList ?? [])
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .filter((f: any) => !isCancelledFill(f)) // drop cancelled fills — never executed
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((f: any) => mapFill(f, account.id, market));
    },

    async getHistoryOrders(account, market, beginMs, endMs): Promise<RawOrder[]> {
      await sleep(paceMs);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const resp: any = await ws.GetHistoryOrderList({
        c2s: { header: header(account, market), filterConditions: { beginTime: fmtFutu(beginMs), endTime: fmtFutu(endMs) } },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (resp?.s2c?.orderList ?? []).map((o: any) => mapOrder(o, account.id, market));
    },

    async getPositions(account, market): Promise<RawPosition[]> {
      await sleep(paceMs);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const resp: any = await ws.GetPositionList({ c2s: { header: header(account, market) } });
      // sync overrides `time` with its snapshot clock; 0 here is a placeholder.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (resp?.s2c?.positionList ?? []).map((p: any) => mapPosition(p, account.id, 0, market));
    },

    close() {
      // stop() only unregisters push callbacks. The real socket + reconnect timer live on the base
      // socket ws.websock (an ftWebsocketBase); its close() kills the reconnect timer and closes the
      // connection (base.js). ftWebsocket itself has no close(), so we must reach ws.websock.
      ws.stop();
      ws.websock?.close?.();
    },
  };
}
