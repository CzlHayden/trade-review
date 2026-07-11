import { test, expect } from "bun:test";
import { isoWeekOf, weekRange, holdBucket } from "../../src/domain/time";

test("isoWeekOf/weekRange round-trip and cover the instant", () => {
  const ms = Date.parse("2026-07-08T12:00:00"); // machine-local (declared tz rule)
  const wk = isoWeekOf(ms);
  expect(wk).toMatch(/^\d{4}-W\d{2}$/);
  const { start, end } = weekRange(wk);
  expect(start).toBeLessThanOrEqual(ms);
  expect(end).toBeGreaterThan(ms);
  // ~7 days: exactly 7×24h in no-DST zones, ±1h across a DST edge (local-calendar arithmetic).
  expect(end - start).toBeGreaterThan(6.9 * 86_400_000);
  expect(end - start).toBeLessThan(7.1 * 86_400_000);
  expect(isoWeekOf(start)).toBe(wk); // start lands inside the same ISO week (no boundary drift)
  expect(isoWeekOf(end)).not.toBe(wk); // end is exclusive — the next week
});

test("holdBucket buckets by hold seconds", () => {
  expect(holdBucket(60)).toBe("intraday");
  expect(holdBucket(3 * 86_400)).toBe("2-5d");
  expect(holdBucket(30 * 86_400)).toBe("2w+");
  expect(holdBucket(null)).toBe("open");
});
