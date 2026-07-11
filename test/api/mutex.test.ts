import { test, expect } from "bun:test";
import { Mutex } from "../../src/api/mutex";

test("runExclusive serializes overlapping critical sections (no interleave)", async () => {
  const m = new Mutex();
  const log: string[] = [];
  const section = (name: string) => async () => {
    log.push(`${name}-start`);
    await new Promise((r) => setTimeout(r, 10));
    log.push(`${name}-end`);
  };
  // Fire both without awaiting the first — the mutex must still run them end-to-end in order.
  const p1 = m.runExclusive(section("A"));
  const p2 = m.runExclusive(section("B"));
  await Promise.all([p1, p2]);
  expect(log).toEqual(["A-start", "A-end", "B-start", "B-end"]);
});

test("a rejecting section does not break the queue", async () => {
  const m = new Mutex();
  const p1 = m.runExclusive(async () => {
    throw new Error("boom");
  });
  const p2 = m.runExclusive(async () => 42);
  await expect(p1).rejects.toThrow("boom");
  expect(await p2).toBe(42); // second still runs
});
