import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../src/store/migrations";
import { buildApi } from "../../src/api/routes";
import { DEFAULT_RULE_CONFIG, type Candle } from "../../src/domain/types";
import { DEFAULT_HEATMAP_GROUPS } from "../../src/store/config";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 6, 17);

/** Two daily bars: yesterday close 100 → today close 110 (+10% day). */
function twoBars(): Candle[] {
  return [
    { time: NOW - DAY, open: 100, high: 100, low: 100, close: 100, volume: 0 },
    { time: NOW, open: 100, high: 110, low: 100, close: 110, volume: 0 },
  ];
}

function harness(candles: (symbol: string) => Promise<Candle[]>) {
  const db = new Database(":memory:");
  runMigrations(db);
  const app = buildApi(db, {
    candles: { getCandles: (symbol) => candles(symbol) },
    config: DEFAULT_RULE_CONFIG,
    sync: null,
    now: () => NOW,
  });
  return { db, app };
}

test("GET /api/market/symbols returns the defaults when nothing is stored", async () => {
  const { app } = harness(async () => []);
  const body: any = await (await app(new Request("http://x/api/market/symbols"))).json();
  expect(body.groups).toEqual(DEFAULT_HEATMAP_GROUPS);
});

test("PUT /api/market/symbols normalizes (uppercase, trim, in-group dedupe, labels) and persists", async () => {
  const { app } = harness(async () => []);
  const put = await app(
    new Request("http://x/api/market/symbols", {
      method: "PUT",
      body: JSON.stringify({
        groups: [
          {
            name: "  Mine ",
            // plain strings (legacy shape) and labeled entries both accepted; a dupe keeps the label
            symbols: ["us.spy", { symbol: "US.SPY", label: " S&P 500 " }, { symbol: " us.qqq ", label: null }],
          },
        ],
      }),
    }),
  );
  expect(put.status).toBe(200);
  const body: any = await put.json();
  expect(body.groups).toEqual([
    // US.QQQ was stored label-less, but it's a known default ticker → its industry label backfills
    // on read (this is what upgrades a config written before labels existed).
    { name: "Mine", symbols: [{ symbol: "US.SPY", label: "S&P 500" }, { symbol: "US.QQQ", label: "Nasdaq 100" }] },
  ]);
  // survives a re-read
  const again: any = await (await app(new Request("http://x/api/market/symbols"))).json();
  expect(again.groups).toEqual(body.groups);
  // an UNKNOWN label-less ticker stays label-less (nothing to backfill from)
  await app(
    new Request("http://x/api/market/symbols", {
      method: "PUT",
      body: JSON.stringify({ groups: [{ name: "X", symbols: ["US.ZZZZ"] }] }),
    }),
  );
  const custom: any = await (await app(new Request("http://x/api/market/symbols"))).json();
  expect(custom.groups).toEqual([{ name: "X", symbols: [{ symbol: "US.ZZZZ", label: null }] }]);
});

test("DELETE /api/market/symbols resets to the built-in defaults (labels, EW group, ordering)", async () => {
  const { app } = harness(async () => []);
  await app(
    new Request("http://x/api/market/symbols", {
      method: "PUT",
      body: JSON.stringify({ groups: [{ name: "Custom", symbols: ["US.SPY"] }] }),
    }),
  );
  const res = await app(new Request("http://x/api/market/symbols", { method: "DELETE" }));
  expect(res.status).toBe(200);
  const body: any = await res.json();
  expect(body.groups).toEqual(DEFAULT_HEATMAP_GROUPS);
  // and the EW group sits directly after the cap-weighted sectors, before Thematic
  const names = body.groups.map((g: any) => g.name);
  expect(names.indexOf("S&P EW sectors")).toBe(names.indexOf("S&P sectors") + 1);
  expect(names.indexOf("S&P EW sectors")).toBeLessThan(names.indexOf("Thematic"));
});

test("PUT /api/market/symbols rejects malformed symbols and oversized bodies", async () => {
  const { app } = harness(async () => []);
  const bad = async (groups: unknown) =>
    (
      await app(new Request("http://x/api/market/symbols", { method: "PUT", body: JSON.stringify({ groups }) }))
    ).status;
  expect(await bad([{ name: "g", symbols: ["SPY"] }])).toBe(400); // missing market prefix
  expect(await bad([{ name: "g", symbols: ["US.SPY; DROP"] }])).toBe(400);
  expect(await bad([{ name: "", symbols: ["US.SPY"] }])).toBe(400);
  expect(await bad("nope")).toBe(400);
  const many = Array.from({ length: 61 }, (_, i) => `US.S${i}`);
  expect(await bad([{ name: "g", symbols: many }])).toBe(400); // > 60 symbols total
});

test("GET /api/market/heatmap computes rows per stored group and degrades bad symbols to nulls", async () => {
  const { app } = harness(async (symbol) => {
    if (symbol === "US.BAD") throw new Error("boom"); // a throwing fetch must not 500 the page
    if (symbol === "US.EMPTY") return [];
    return twoBars();
  });
  await app(
    new Request("http://x/api/market/symbols", {
      method: "PUT",
      body: JSON.stringify({
        groups: [{ name: "G", symbols: [{ symbol: "US.OK", label: "Okay Industries" }, "US.EMPTY", "US.BAD"] }],
      }),
    }),
  );
  const res = await app(new Request("http://x/api/market/heatmap"));
  expect(res.status).toBe(200);
  const body: any = await res.json();
  expect(body.asOf).toBe(NOW);
  expect(body.groups).toHaveLength(1);
  const rows = body.groups[0].rows;
  expect(rows.map((r: any) => r.symbol)).toEqual(["US.OK", "US.EMPTY", "US.BAD"]);
  expect(rows[0].label).toBe("Okay Industries"); // the stored industry label rides along per row
  expect(rows[1].label).toBeNull();
  expect(rows[0].last).toBe(110);
  expect(rows[0].dayPct).toBeCloseTo(0.1, 10);
  expect(rows[1].last).toBeNull();
  expect(rows[2].dayPct).toBeNull();
});
