import { test, expect } from "bun:test";
import { money, pct, rMultiple, signClass, holdTime, humanizeRule } from "../../web/lib/format";

test("money shows sign + currency symbol, never converts", () => {
  expect(money(1234.5, "USD")).toBe("+$1,234.50");
  expect(money(-88.99, "USD")).toBe("−$88.99");
  expect(money(0, "USD")).toBe("$0.00");
  expect(money(100, "HKD")).toBe("+HK$100.00");
  expect(money(50, "CNH")).toBe("+¥50.00");
});

test("pct and rMultiple", () => {
  expect(pct(0.615)).toBe("61.5%");
  expect(rMultiple(2.4)).toBe("+2.40R");
  expect(rMultiple(-1)).toBe("−1.00R");
  expect(rMultiple(null)).toBe("—");
});

test("signClass colors by sign", () => {
  expect(signClass(5)).toBe("pos");
  expect(signClass(-5)).toBe("neg");
  expect(signClass(0)).toBe("");
  expect(signClass(null)).toBe("");
});

test("holdTime buckets seconds; null is open", () => {
  expect(holdTime(null)).toBe("open");
  expect(holdTime(1800)).toBe("30m");
  expect(holdTime(3 * 3600)).toBe("3h");
  expect(holdTime(2 * 86400)).toBe("2d");
  expect(holdTime(21 * 86400)).toBe("3w");
});

test("humanizeRule prettifies rule ids", () => {
  expect(humanizeRule("held_past_stop")).toBe("Held past stop");
  expect(humanizeRule("round_tripped_gain")).toBe("Round tripped gain");
});
