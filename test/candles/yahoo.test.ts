import { test, expect } from "bun:test";
import { yahooSymbol, intervalFor, parseChart, getCandles } from "../../src/candles/yahoo";
import fixture from "../fixtures/yahoo-aapl.json";

test("yahooSymbol maps US and HK", () => {
  expect(yahooSymbol("US.AAPL")).toBe("AAPL");
  expect(yahooSymbol("HK.00700")).toBe("0700.HK");
});

test("yahooSymbol throws on unsupported market", () => {
  expect(() => yahooSymbol("CN.600000")).toThrow();
});

test("intervalFor maps resolution ms", () => {
  expect(intervalFor(86_400_000)).toBe("1d");
  expect(intervalFor(3_600_000)).toBe("1h");
  expect(intervalFor(60_000)).toBe("1m");
});

test("parseChart yields OHLCV in ms, skipping null gaps", () => {
  const candles = parseChart(fixture);
  expect(candles.length).toBe(2); // 3 timestamps, middle one has null close → skipped
  expect(candles[0]!.time).toBe(1_700_000_000_000); // seconds → ms
  for (const c of candles) {
    expect(c.close).not.toBeNull();
    expect(c.high).toBeGreaterThanOrEqual(c.low);
  }
});

test("parseChart returns [] on a malformed body", () => {
  expect(parseChart({})).toEqual([]);
  expect(parseChart({ chart: { result: [] } })).toEqual([]);
});

test("getCandles builds the URL, uses injected fetch, returns parsed candles", async () => {
  let calledUrl = "";
  const fakeFetch = async (url: string) => {
    calledUrl = url;
    return { ok: true, json: async () => fixture };
  };
  const out = await getCandles("US.AAPL", 1_700_000_000_000, 1_700_200_000_000, 86_400_000, fakeFetch);
  expect(calledUrl).toContain("/v8/finance/chart/AAPL");
  expect(calledUrl).toContain("interval=1d");
  expect(calledUrl).toContain("period1=1700000000"); // seconds, not ms
  expect(out.length).toBe(2);
});

test("getCandles returns [] on a non-ok response", async () => {
  const fakeFetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
  expect(await getCandles("US.AAPL", 1, 2, 86_400_000, fakeFetch)).toEqual([]);
});

test("getCandles returns [] (never throws) on an unsupported market", async () => {
  const fakeFetch = async () => ({ ok: true, json: async () => fixture });
  expect(await getCandles("CN.600000", 1, 2, 86_400_000, fakeFetch)).toEqual([]);
});

test("getCandles returns [] when fetch itself rejects", async () => {
  const fakeFetch = async () => {
    throw new Error("network down");
  };
  expect(await getCandles("US.AAPL", 1, 2, 86_400_000, fakeFetch)).toEqual([]);
});
