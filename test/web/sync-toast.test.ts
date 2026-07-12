import { test, expect } from "bun:test";
import { syncToastContent } from "../../web/lib/sync-toast";
import type { SyncStatus } from "../../web/lib/api";

const base: SyncStatus = {
  running: false,
  startedAt: null,
  finishedAt: 1000,
  lastResult: null,
  lastError: null,
};

test("a failed sync yields an error toast carrying the message", () => {
  const t = syncToastContent({ ...base, lastError: "OpenD login failed" });
  expect(t).toEqual({ kind: "err", title: "Sync failed", body: "OpenD login failed" });
});

test("a successful sync summarizes counts, pluralized", () => {
  const t = syncToastContent({
    ...base,
    lastResult: { accounts: 2, fills: 33, orders: 83, trades: 16, flags: 9 },
  });
  expect(t).toEqual({ kind: "ok", title: "Synced", body: "16 trades · 9 flags · 2 accounts" });
});

test("singular counts drop the plural 's'", () => {
  const t = syncToastContent({
    ...base,
    lastResult: { accounts: 1, fills: 1, orders: 1, trades: 1, flags: 1 },
  });
  expect(t?.body).toBe("1 trade · 1 flag · 1 account");
});

test("no completion data yields no toast", () => {
  expect(syncToastContent({ ...base, finishedAt: null })).toBeNull();
});

test("an error takes precedence over a stale prior result", () => {
  const t = syncToastContent({
    ...base,
    lastError: "network down",
    lastResult: { accounts: 1, fills: 1, orders: 1, trades: 1, flags: 1 },
  });
  expect(t?.kind).toBe("err");
});
