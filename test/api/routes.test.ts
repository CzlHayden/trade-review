import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../src/store/migrations";
import { buildApi } from "../../src/api/routes";
import { SyncRunner } from "../../src/api/sync-runner";
import { upsertRawFills } from "../../src/store/repos";
import { rebuildDerived } from "../../src/sync/sync";
import { DEFAULT_RULE_CONFIG } from "../../src/domain/types";

const noCandles = { getCandles: async () => [] };

async function api() {
  const db = new Database(":memory:");
  runMigrations(db);
  upsertRawFills(db, [
    { id: "f1", orderId: "o1", symbol: "US.AAPL", side: "BUY", qty: 10, price: 100, fee: 0, currency: "USD", time: 1000, account: "a" },
    { id: "f2", orderId: "o2", symbol: "US.AAPL", side: "SELL", qty: 10, price: 110, fee: 0, currency: "USD", time: 2000, account: "a" },
  ]);
  await rebuildDerived(db, { candles: noCandles, config: DEFAULT_RULE_CONFIG, now: 3000 });
  const app = buildApi(db, { candles: noCandles, config: DEFAULT_RULE_CONFIG, sync: null, now: () => 3000 });
  return { db, app };
}

test("GET /api/stats returns currency-segmented stats", async () => {
  const { app } = await api();
  const res = await app(new Request("http://x/api/stats"));
  expect(res.status).toBe(200);
  const body: any = await res.json();
  expect(body.byCurrency[0].currency).toBe("USD");
  expect(body.byCurrency[0].netPnl).toBe(100);
});

test("GET /api/trades embeds flags + setup + tags; unknown detail 404s", async () => {
  const { app } = await api();
  const list: any = await (await app(new Request("http://x/api/trades"))).json();
  expect(list).toHaveLength(1);
  expect(list[0]).toHaveProperty("flags");
  expect(list[0]).toHaveProperty("tags");
  const missing = await app(new Request("http://x/api/trades/nope"));
  expect(missing.status).toBe(404);
});

test("GET /api/trades/:id returns detail with fills + inferred stop", async () => {
  const { app } = await api();
  const id = ((await (await app(new Request("http://x/api/trades"))).json()) as any)[0].id;
  const detail: any = await (await app(new Request(`http://x/api/trades/${id}`))).json();
  expect(detail.trade.id).toBe(id);
  expect(detail.fills).toHaveLength(2);
  expect(detail).toHaveProperty("stop");
});

test("GET /api/positions groups by currency", async () => {
  const { app } = await api();
  const body: any = await (await app(new Request("http://x/api/positions"))).json();
  expect(body).toHaveProperty("byCurrency");
  expect(Array.isArray(body.byCurrency)).toBe(true);
});

test("GET /api/meta returns currencies + version", async () => {
  const { app } = await api();
  const m: any = await (await app(new Request("http://x/api/meta"))).json();
  expect(m.currencies).toContain("USD");
  expect(typeof m.appVersion).toBe("string");
});

test("GET /api/breakdowns?by=symbol groups per currency; bad key 400s", async () => {
  const { app } = await api();
  const rows: any = await (await app(new Request("http://x/api/breakdowns?by=symbol"))).json();
  expect(rows[0].key).toBe("US.AAPL");
  expect(rows[0].currency).toBe("USD");
  const bad = await app(new Request("http://x/api/breakdowns?by=nonsense"));
  expect(bad.status).toBe(400);
});

test("unknown /api path 404s as JSON", async () => {
  const { app } = await api();
  const res = await app(new Request("http://x/api/nonsense"));
  expect(res.status).toBe(404);
  expect(res.headers.get("content-type")).toContain("application/json");
});

test("the bare /api root returns the API's JSON 404 (not the SPA shell)", async () => {
  const { app } = await api();
  const res = await app(new Request("http://x/api"));
  expect(res.status).toBe(404);
  expect(res.headers.get("content-type")).toContain("application/json");
});

test("PUT journal with a manual stop recomputes R via rebuild", async () => {
  const { app } = await api();
  const id = ((await (await app(new Request("http://x/api/trades"))).json()) as any)[0].id;
  const put = await app(
    new Request(`http://x/api/trades/${id}/journal`, {
      method: "PUT",
      body: JSON.stringify({
        thesis: "t", emotion: null, conviction: 4, rating: null, notes: null,
        manualStop: 95, setup: "breakout", tags: ["a"],
      }),
    }),
  );
  expect(put.status).toBe(200);
  const detail: any = await put.json();
  expect(detail.trade.risk).toBeCloseTo(50);
  expect(detail.trade.rMultiple).toBeCloseTo(2);
  expect(detail.journal.setup).toBe("breakout");
});

test("PUT journal rejects a non-object JSON body (null/array/string) with 400", async () => {
  const { app } = await api();
  const id = ((await (await app(new Request("http://x/api/trades"))).json()) as any)[0].id;
  for (const body of ["null", "[]", '"hi"', "not json"]) {
    const res = await app(
      new Request(`http://x/api/trades/${id}/journal`, { method: "PUT", body }),
    );
    expect(res.status).toBe(400);
  }
});

test("PUT journal rejects a wrong-typed manual stop (string) instead of silently clearing it", async () => {
  const { app } = await api();
  const id = ((await (await app(new Request("http://x/api/trades"))).json()) as any)[0].id;
  // First set a real manual stop.
  await app(
    new Request(`http://x/api/trades/${id}/journal`, {
      method: "PUT",
      body: JSON.stringify({ manualStop: 95, tags: [] }),
    }),
  );
  // A string manualStop must 400, not coerce to null and wipe the stop.
  const res = await app(
    new Request(`http://x/api/trades/${id}/journal`, {
      method: "PUT",
      body: JSON.stringify({ manualStop: "94", tags: [] }),
    }),
  );
  expect(res.status).toBe(400);
  const detail: any = await (await app(new Request(`http://x/api/trades/${id}`))).json();
  expect(detail.journal.manualStop).toBe(95); // unchanged
});

test("GET /api/trades/:id/candles defaults to res=1d, reports the window, and returns {res,resMs,focusFrom,focusTo,candles}", async () => {
  const db = new Database(":memory:");
  runMigrations(db);
  upsertRawFills(db, [
    { id: "f1", orderId: "o1", symbol: "US.AAPL", side: "BUY", qty: 10, price: 100, fee: 0, currency: "USD", time: 1000, account: "a" },
    { id: "f2", orderId: "o2", symbol: "US.AAPL", side: "SELL", qty: 10, price: 110, fee: 0, currency: "USD", time: 2000, account: "a" },
  ]);
  await rebuildDerived(db, { candles: noCandles, config: DEFAULT_RULE_CONFIG, now: 3000 });
  const calls: { fromMs: number; toMs: number; resMs: number }[] = [];
  const candles = {
    getCandles: async (_symbol: string, fromMs: number, toMs: number, resMs: number) => {
      calls.push({ fromMs, toMs, resMs });
      return [{ time: 1500, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }];
    },
  };
  const app = buildApi(db, { candles, config: DEFAULT_RULE_CONFIG, sync: null, now: () => 3000 });
  const id = ((await (await app(new Request("http://x/api/trades"))).json()) as any)[0].id;

  const res = await app(new Request(`http://x/api/trades/${id}/candles`));
  expect(res.status).toBe(200);
  const body: any = await res.json();
  expect(body.res).toBe("1d");
  expect(body.resMs).toBe(86_400_000);
  expect(body.candles).toHaveLength(1);
  expect(body.focusFrom).toBeLessThanOrEqual(1000); // brackets the trade's openTime
  expect(body.focusTo).toBeGreaterThanOrEqual(2000); // brackets the trade's closeTime
  expect(calls).toHaveLength(1); // no ladder needed — the source returned bars on the first try
  expect(calls[0]!.resMs).toBe(86_400_000);
  expect(calls[0]!.fromMs).toBe(1000 - 365 * 86_400_000); // openTime - 365d, per windowFor
});

test("GET .../candles?res=bogus falls back to 1d (unknown resolutions are ignored, not 500s)", async () => {
  const { app } = await api();
  const id = ((await (await app(new Request("http://x/api/trades"))).json()) as any)[0].id;
  const res = await app(new Request(`http://x/api/trades/${id}/candles?res=bogus`));
  expect(res.status).toBe(200);
  const body: any = await res.json();
  expect(body.res).toBe("1d");
});

test("GET .../candles?res=15m ladders 15m→1h→1d on empty results and reports the res that produced bars", async () => {
  const db = new Database(":memory:");
  runMigrations(db);
  upsertRawFills(db, [
    { id: "f1", orderId: "o1", symbol: "US.AAPL", side: "BUY", qty: 10, price: 100, fee: 0, currency: "USD", time: 1000, account: "a" },
    { id: "f2", orderId: "o2", symbol: "US.AAPL", side: "SELL", qty: 10, price: 110, fee: 0, currency: "USD", time: 2000, account: "a" },
  ]);
  await rebuildDerived(db, { candles: noCandles, config: DEFAULT_RULE_CONFIG, now: 3000 });
  const seenResMs: number[] = [];
  // Yahoo has no intraday reach this far back (per this test's fixed clock) — 15m and 1h both come
  // back empty; only the 1d fetch (unbounded reach) yields bars.
  const candles = {
    getCandles: async (_symbol: string, _fromMs: number, _toMs: number, resMs: number) => {
      seenResMs.push(resMs);
      return resMs === 86_400_000 ? [{ time: 1500, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }] : [];
    },
  };
  const app = buildApi(db, { candles, config: DEFAULT_RULE_CONFIG, sync: null, now: () => 3000 });
  const id = ((await (await app(new Request("http://x/api/trades"))).json()) as any)[0].id;

  const res = await app(new Request(`http://x/api/trades/${id}/candles?res=15m`));
  expect(res.status).toBe(200);
  const body: any = await res.json();
  expect(body.res).toBe("1d"); // reports the res that actually produced bars, not the requested one
  expect(body.resMs).toBe(86_400_000);
  expect(body.candles).toHaveLength(1);
  expect(seenResMs).toEqual([900_000, 3_600_000, 86_400_000]); // 15m → 1h → 1d, in order
});

test("GET .../candles coarsens past an intraday res whose window can't reach back to the entry, even when that res returns bars", async () => {
  // Old/long trade: entry ~800 days before `now`, so neither 15m (58d reach) nor 1h (720d reach) can
  // fetch back to the entry. The source returns bars for EVERY resolution — the ladder must still climb
  // to 1d (unbounded reach) so the chart includes the entry/initial-stop, not just recent bars.
  const DAY = 86_400_000;
  const now = 805 * DAY;
  const db = new Database(":memory:");
  runMigrations(db);
  upsertRawFills(db, [
    { id: "f1", orderId: "o1", symbol: "US.AAPL", side: "BUY", qty: 10, price: 100, fee: 0, currency: "USD", time: 5 * DAY, account: "a" },
    { id: "f2", orderId: "o2", symbol: "US.AAPL", side: "SELL", qty: 10, price: 110, fee: 0, currency: "USD", time: 6 * DAY, account: "a" },
  ]);
  await rebuildDerived(db, { candles: noCandles, config: DEFAULT_RULE_CONFIG, now });
  const seenResMs: number[] = [];
  const candles = {
    getCandles: async (_symbol: string, _fromMs: number, _toMs: number, resMs: number) => {
      seenResMs.push(resMs);
      return [{ time: 5 * DAY + 3600_000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }];
    },
  };
  const app = buildApi(db, { candles, config: DEFAULT_RULE_CONFIG, sync: null, now: () => now });
  const id = ((await (await app(new Request("http://x/api/trades"))).json()) as any)[0].id;

  const body: any = await (await app(new Request(`http://x/api/trades/${id}/candles?res=15m`))).json();
  expect(seenResMs).toEqual([900_000, 3_600_000, 86_400_000]); // climbs though every res returned bars
  expect(body.res).toBe("1d");
  expect(body.focusFrom).toBeLessThanOrEqual(5 * DAY); // 1d window covers the entry
});

test("GET .../candles keeps an intraday res that DOES reach the entry (no needless coarsening)", async () => {
  // Recent trade well inside the 15m reach — the first fetch both returns bars and covers the entry,
  // so the ladder stops at 15m.
  const DAY = 86_400_000;
  const now = 100 * DAY;
  const db = new Database(":memory:");
  runMigrations(db);
  upsertRawFills(db, [
    { id: "f1", orderId: "o1", symbol: "US.AAPL", side: "BUY", qty: 10, price: 100, fee: 0, currency: "USD", time: 99 * DAY, account: "a" },
    { id: "f2", orderId: "o2", symbol: "US.AAPL", side: "SELL", qty: 10, price: 110, fee: 0, currency: "USD", time: 99 * DAY + 3600_000, account: "a" },
  ]);
  await rebuildDerived(db, { candles: noCandles, config: DEFAULT_RULE_CONFIG, now });
  const seenResMs: number[] = [];
  const candles = {
    getCandles: async (_symbol: string, _fromMs: number, _toMs: number, resMs: number) => {
      seenResMs.push(resMs);
      return [{ time: 99 * DAY + 900_000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }];
    },
  };
  const app = buildApi(db, { candles, config: DEFAULT_RULE_CONFIG, sync: null, now: () => now });
  const id = ((await (await app(new Request("http://x/api/trades"))).json()) as any)[0].id;

  const body: any = await (await app(new Request(`http://x/api/trades/${id}/candles?res=15m`))).json();
  expect(seenResMs).toEqual([900_000]); // one fetch, no ladder
  expect(body.res).toBe("15m");
});

test("PUT drawings strips a non-schema point field (dataIndex) so overlays can't re-anchor by index", async () => {
  const { app } = await api();
  const id = ((await (await app(new Request("http://x/api/trades"))).json()) as any)[0].id;
  const put: any = await (
    await app(
      new Request(`http://x/api/trades/${id}/drawings`, {
        method: "PUT",
        body: JSON.stringify({
          drawings: [{ name: "segment", points: [{ timestamp: 1000, value: 5, dataIndex: 3 }, { timestamp: 2000, value: 6, dataIndex: 4 }] }],
        }),
      }),
    )
  ).json();
  expect(put.drawings).toEqual([{ name: "segment", points: [{ timestamp: 1000, value: 5 }, { timestamp: 2000, value: 6 }] }]);
  const get: any = await (await app(new Request(`http://x/api/trades/${id}/drawings`))).json();
  expect(get.drawings[0].points[0]).not.toHaveProperty("dataIndex");
});

test("PUT drawings preserves drawing-level extendData (labels/metadata) while stripping point dataIndex", async () => {
  const { app } = await api();
  const id = ((await (await app(new Request("http://x/api/trades"))).json()) as any)[0].id;
  const put: any = await (
    await app(
      new Request(`http://x/api/trades/${id}/drawings`, {
        method: "PUT",
        body: JSON.stringify({
          drawings: [{ name: "simpleAnnotation", points: [{ timestamp: 1000, value: 5, dataIndex: 2 }], extendData: "my note" }],
        }),
      }),
    )
  ).json();
  expect(put.drawings).toEqual([{ name: "simpleAnnotation", points: [{ timestamp: 1000, value: 5 }], extendData: "my note" }]);
});

test("GET /api/trades/:id/candles 404s for an unknown trade id", async () => {
  const { app } = await api();
  const res = await app(new Request("http://x/api/trades/nope/candles"));
  expect(res.status).toBe(404);
});

test("a note-only journal edit does NOT trigger a rebuild (no candle fetches)", async () => {
  const db = new Database(":memory:");
  runMigrations(db);
  upsertRawFills(db, [
    { id: "f1", orderId: "o1", symbol: "US.AAPL", side: "BUY", qty: 10, price: 100, fee: 0, currency: "USD", time: 1000, account: "a" },
    { id: "f2", orderId: "o2", symbol: "US.AAPL", side: "SELL", qty: 10, price: 110, fee: 0, currency: "USD", time: 2000, account: "a" },
  ]);
  await rebuildDerived(db, { candles: noCandles, config: DEFAULT_RULE_CONFIG, now: 3000 });
  let fetches = 0;
  const counting = {
    getCandles: async () => {
      fetches++;
      return [];
    },
  };
  const app = buildApi(db, { candles: counting, config: DEFAULT_RULE_CONFIG, sync: null, now: () => 3000 });
  const id = ((await (await app(new Request("http://x/api/trades"))).json()) as any)[0].id;

  await app(new Request(`http://x/api/trades/${id}/journal`, { method: "PUT", body: JSON.stringify({ notes: "first", tags: [] }) }));
  expect(fetches).toBe(0); // notes-only, no derived change → no rebuild → no candle fetch

  await app(new Request(`http://x/api/trades/${id}/journal`, { method: "PUT", body: JSON.stringify({ manualStop: 95, tags: [] }) }));
  expect(fetches).toBeGreaterThan(0); // manual stop changed → rebuild ran
});

test("PUT journal rejects out-of-range conviction", async () => {
  const { app } = await api();
  const id = ((await (await app(new Request("http://x/api/trades"))).json()) as any)[0].id;
  const res = await app(
    new Request(`http://x/api/trades/${id}/journal`, {
      method: "PUT",
      body: JSON.stringify({ conviction: 9, tags: [] }),
    }),
  );
  expect(res.status).toBe(400);
});

test("PUT then GET /api/trades/:id/drawings round-trips", async () => {
  const { app } = await api();
  const id = ((await (await app(new Request("http://x/api/trades"))).json()) as any)[0].id;
  const drawings = [
    { name: "trendline", points: [{ timestamp: 1000, value: 10 }, { timestamp: 2000, value: 12 }] },
  ];
  const put = await app(
    new Request(`http://x/api/trades/${id}/drawings`, {
      method: "PUT",
      body: JSON.stringify({ drawings }),
    }),
  );
  expect(put.status).toBe(200);
  const putBody: any = await put.json();
  expect(putBody.drawings).toEqual(drawings);
  const get: any = await (await app(new Request(`http://x/api/trades/${id}/drawings`))).json();
  expect(get.drawings).toEqual(drawings);
});

test("PUT drawings rejects a non-array drawings field with 400", async () => {
  const { app } = await api();
  const id = ((await (await app(new Request("http://x/api/trades"))).json()) as any)[0].id;
  const res = await app(
    new Request(`http://x/api/trades/${id}/drawings`, {
      method: "PUT",
      body: JSON.stringify({ drawings: "nope" }),
    }),
  );
  expect(res.status).toBe(400);
});

test("PUT drawings rejects more than 200 drawings with 400", async () => {
  const { app } = await api();
  const id = ((await (await app(new Request("http://x/api/trades"))).json()) as any)[0].id;
  const drawings = Array.from({ length: 201 }, (_, i) => ({ name: `d${i}`, points: [] }));
  const res = await app(
    new Request(`http://x/api/trades/${id}/drawings`, {
      method: "PUT",
      body: JSON.stringify({ drawings }),
    }),
  );
  expect(res.status).toBe(400);
});

test("PUT drawings rejects a malformed element (missing name / bad points) with 400", async () => {
  const { app } = await api();
  const id = ((await (await app(new Request("http://x/api/trades"))).json()) as any)[0].id;
  const noName = await app(
    new Request(`http://x/api/trades/${id}/drawings`, {
      method: "PUT",
      body: JSON.stringify({ drawings: [{ points: [] }] }),
    }),
  );
  expect(noName.status).toBe(400);
  const badPoints = await app(
    new Request(`http://x/api/trades/${id}/drawings`, {
      method: "PUT",
      body: JSON.stringify({ drawings: [{ name: "a", points: "nope" }] }),
    }),
  );
  expect(badPoints.status).toBe(400);
  const badPointShape = await app(
    new Request(`http://x/api/trades/${id}/drawings`, {
      method: "PUT",
      body: JSON.stringify({ drawings: [{ name: "a", points: [{ timestamp: "nope" }] }] }),
    }),
  );
  expect(badPointShape.status).toBe(400);
});

test("weekly entry GET/PUT round-trips and lists that week's trades", async () => {
  const { app } = await api();
  await app(
    new Request("http://x/api/journal/weeks/2026-W28", {
      method: "PUT",
      body: JSON.stringify({ marketRead: "risk-on", tradedVsPlan: "ok", watchlist: [] }),
    }),
  );
  const got: any = await (await app(new Request("http://x/api/journal/weeks/2026-W28"))).json();
  expect(got.marketRead).toBe("risk-on");
  expect(Array.isArray(got.trades)).toBe(true);
});

test("weekly endpoint rejects a non-canonical ISO week key (400, no row stored)", async () => {
  const { app } = await api();
  const bad = await app(
    new Request("http://x/api/journal/weeks/2026-W99", {
      method: "PUT",
      body: JSON.stringify({ marketRead: "x", watchlist: [] }),
    }),
  );
  expect(bad.status).toBe(400);
});

test("POST /api/sync starts (202) then refuses a concurrent start (409); status is readable", async () => {
  const db = new Database(":memory:");
  runMigrations(db);
  const runner = new SyncRunner(
    db,
    async () => {
      await new Promise((r) => setTimeout(r, 20));
      return { accounts: 1, fills: 0, orders: 0, trades: 0, flags: 0 };
    },
    () => 1,
  );
  const app = buildApi(db, { candles: noCandles, config: DEFAULT_RULE_CONFIG, sync: runner, now: () => 1 });
  const first = await app(new Request("http://x/api/sync", { method: "POST" }));
  expect(first.status).toBe(202);
  const second = await app(new Request("http://x/api/sync", { method: "POST" }));
  expect(second.status).toBe(409);
  const status: any = await (await app(new Request("http://x/api/sync/status"))).json();
  expect(status.running).toBe(true);
  await runner.whenIdle();
});

test("sync endpoints 503 when no runner is wired", async () => {
  const { app } = await api(); // sync: null
  const res = await app(new Request("http://x/api/sync", { method: "POST" }));
  expect(res.status).toBe(503);
});
