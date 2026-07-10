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
import { mapAccount, mapFill, mapOrder, mapPosition, TRD_ENV_REAL } from "./map";

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
}

export async function connectFutu(opts: ConnectOpts = {}): Promise<FutuClient> {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 33334;
  const key = opts.key;
  const paceMs = opts.paceMs ?? 350;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ws: any = new ftWebsocket();

  await new Promise<void>((resolve, reject) => {
    ws.onlogin = (ok: boolean, msg: unknown) =>
      ok ? resolve() : reject(new Error(`OpenD login failed: ${JSON.stringify(msg)}`));
    ws.start(host, port, false, key); // (ip, port, ssl=false, plaintext key)
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (resp?.s2c?.orderFillList ?? []).map((f: any) => mapFill(f, account.id, market));
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
      // stop() only unregisters push callbacks; close() kills the reconnect timer and closes the
      // underlying socket (see node_modules/futu-api base.js) — call both so no socket leaks.
      ws.stop();
      ws.close?.();
    },
  };
}
