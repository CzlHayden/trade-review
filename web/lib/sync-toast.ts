import type { SyncStatus } from "./api";
import type { ToastKind } from "../components/Toast";

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** Derive the notification for a COMPLETED sync from its status. An error wins over a stale prior
 * result; a success summarizes the counts. Returns null when there's nothing to report yet. */
export function syncToastContent(
  status: SyncStatus,
): { kind: ToastKind; title: string; body: string } | null {
  if (status.lastError) {
    return { kind: "err", title: "Sync failed", body: status.lastError };
  }
  if (status.finishedAt !== null && status.lastResult) {
    const r = status.lastResult;
    return {
      kind: "ok",
      title: "Synced",
      body: `${count(r.trades, "trade")} · ${count(r.flags, "flag")} · ${count(r.accounts, "account")}`,
    };
  }
  return null;
}
