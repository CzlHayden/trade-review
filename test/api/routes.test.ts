import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../src/store/migrations";
import { buildApi } from "../../src/api/routes";
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
