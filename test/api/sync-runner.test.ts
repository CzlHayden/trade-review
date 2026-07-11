import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../src/store/migrations";
import { SyncRunner } from "../../src/api/sync-runner";

function db() {
  const d = new Database(":memory:");
  runMigrations(d);
  return d;
}

test("SyncRunner runs one job, exposes status, and refuses concurrent starts", async () => {
  const d = db();
  let running = 0,
    maxConcurrent = 0;
  const job = async () => {
    running++;
    maxConcurrent = Math.max(maxConcurrent, running);
    await new Promise((r) => setTimeout(r, 20));
    running--;
    return { accounts: 1, fills: 0, orders: 0, trades: 0, flags: 0 };
  };
  const runner = new SyncRunner(d, job, () => 111);
  const started1 = runner.start();
  const started2 = runner.start(); // while first in flight
  expect(started1).toBe(true);
  expect(started2).toBe(false); // mutex refuses the second
  expect(runner.status().running).toBe(true);
  await runner.whenIdle();
  expect(maxConcurrent).toBe(1);
  const s = runner.status();
  expect(s.running).toBe(false);
  expect(s.lastResult?.accounts).toBe(1);
});

test("a job that throws records lastError and clears running", async () => {
  const d = db();
  const runner = new SyncRunner(
    d,
    async () => {
      throw new Error("OpenD down");
    },
    () => 1,
  );
  runner.start();
  await runner.whenIdle();
  expect(runner.status().running).toBe(false);
  expect(runner.status().lastError).toContain("OpenD down");
});

test("status persists across a fresh runner (config-backed)", async () => {
  const d = db();
  const r1 = new SyncRunner(d, async () => ({ accounts: 2, fills: 5, orders: 3, trades: 1, flags: 0 }), () => 7);
  r1.start();
  await r1.whenIdle();
  const r2 = new SyncRunner(d, async () => ({ accounts: 0, fills: 0, orders: 0, trades: 0, flags: 0 }), () => 9);
  expect(r2.status().lastResult?.accounts).toBe(2); // loaded from config, not from r2's own run
});
