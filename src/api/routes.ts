// The JSON API as a plain fetch handler: buildApi(db, deps) → (Request) => Promise<Response>.
// Kept framework-free and server-free so tests call it directly against an in-memory DB. Money
// aggregates always cross the wire under a `byCurrency` shape — never a bare top-level total.
import type { Database } from "bun:sqlite";
import type { CandleSource } from "../domain/ports";
import type { RuleConfig, Trade } from "../domain/types";
import { computeStats, breakdown } from "../core/analytics";
import { allTrades, flagsForTrade } from "../store/repos";
import { holdBucket, isoWeekOf, weekRange } from "../domain/time";
import type { Journal, WatchlistItem } from "../domain/journal-types";
import {
  getWeeklyEntry,
  tradesInRange,
  upsertJournal,
  upsertWeeklyEntry,
} from "../store/journal";
import { rebuildDerived } from "../sync/sync";
import {
  latestSnapshotTime,
  metaView,
  openPositions,
  tradeDetail,
  type OpenPosition,
} from "./views";
import type { SyncRunner } from "./sync-runner";

const DAY_MS = 86_400_000;
const PAD_MS = 2 * DAY_MS;

export interface ApiDeps {
  candles: CandleSource;
  config: RuleConfig;
  sync: SyncRunner | null;
  now: () => number;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** trade_id → setup (single) and trade_id → tags (multi), for embedding + breakdowns. */
function setupMap(db: Database): Map<string, string> {
  const rows = db.query(`SELECT trade_id, setup FROM journal WHERE setup IS NOT NULL`).all() as any[];
  return new Map(rows.map((r) => [r.trade_id as string, r.setup as string]));
}
function tagsMap(db: Database): Map<string, string[]> {
  const rows = db.query(`SELECT trade_id, tag FROM journal_tags`).all() as any[];
  const m = new Map<string, string[]>();
  for (const r of rows) {
    const arr = m.get(r.trade_id) ?? [];
    arr.push(r.tag);
    m.set(r.trade_id, arr);
  }
  return m;
}

function tradesWithMeta(db: Database) {
  const setups = setupMap(db);
  const tags = tagsMap(db);
  return allTrades(db).map((t) => ({
    ...t,
    flags: flagsForTrade(db, t.id),
    setup: setups.get(t.id) ?? null,
    tags: tags.get(t.id) ?? [],
  }));
}

function breakdownBy(db: Database, by: string) {
  const trades = allTrades(db);
  if (by === "symbol") return breakdown(trades, (t) => t.symbol);
  if (by === "holdBucket") return breakdown(trades, (t) => holdBucket(t.holdSeconds));
  if (by === "setup") {
    const setups = setupMap(db);
    return breakdown(trades, (t) => setups.get(t.id) ?? null);
  }
  if (by === "tag") {
    // A trade can carry several tags → it must count in each tag's group. Expand to one distinct
    // trade-clone per tag so the tested breakdown() groups each (currency, tag) exactly once.
    const tags = tagsMap(db);
    const tagOf = new Map<Trade, string>();
    const expanded: Trade[] = [];
    for (const t of trades) {
      for (const tag of tags.get(t.id) ?? []) {
        const clone = { ...t };
        tagOf.set(clone, tag);
        expanded.push(clone);
      }
    }
    return breakdown(expanded, (t) => tagOf.get(t) ?? null);
  }
  return null;
}

/** A 1..5 score is valid, or null/absent (the field is optional). */
function validScore(v: unknown): boolean {
  return v == null || (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 5);
}

/** Group open positions per currency so the wire shape can't be summed across currencies. */
function positionsByCurrency(positions: OpenPosition[]) {
  const groups = new Map<string, OpenPosition[]>();
  for (const p of positions) {
    const arr = groups.get(p.currency) ?? [];
    arr.push(p);
    groups.set(p.currency, arr);
  }
  return {
    byCurrency: [...groups.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([currency, ps]) => ({ currency, positions: ps })),
  };
}

export function buildApi(db: Database, deps: ApiDeps): (req: Request) => Promise<Response> {
  return async (req) => {
    const url = new URL(req.url);
    const seg = url.pathname.split("/").filter(Boolean); // ["api","trades","t1","candles"]
    const method = req.method;
    try {
      if (seg[0] !== "api") return json({ error: "not found" }, 404);

      // GET /api/stats
      if (seg.length === 2 && seg[1] === "stats" && method === "GET") {
        return json(computeStats(allTrades(db)));
      }
      // GET /api/breakdowns?by=setup|tag|symbol|holdBucket
      if (seg.length === 2 && seg[1] === "breakdowns" && method === "GET") {
        const by = url.searchParams.get("by") ?? "setup";
        const rows = breakdownBy(db, by);
        if (rows === null) return json({ error: `unknown breakdown: ${by}` }, 400);
        return json(rows);
      }
      // GET /api/trades
      if (seg.length === 2 && seg[1] === "trades" && method === "GET") {
        return json(tradesWithMeta(db));
      }
      // /api/trades/:id  and  /api/trades/:id/candles  and  PUT /api/trades/:id/journal
      if (seg.length >= 3 && seg[1] === "trades") {
        const id = decodeURIComponent(seg[2]!);
        if (seg.length === 3 && method === "GET") {
          const detail = tradeDetail(db, id);
          return detail ? json(detail) : json({ error: "trade not found" }, 404);
        }
        if (seg.length === 4 && seg[3] === "journal" && method === "PUT") {
          if (!allTrades(db).some((t) => t.id === id)) {
            return json({ error: "trade not found" }, 404);
          }
          const b = (await req.json()) as any;
          if (!validScore(b.conviction) || !validScore(b.rating)) {
            return json({ error: "conviction/rating must be an integer 1..5 or null" }, 400);
          }
          const journal: Journal = {
            tradeId: id,
            thesis: b.thesis ?? null,
            emotion: b.emotion ?? null,
            conviction: b.conviction ?? null,
            rating: b.rating ?? null,
            notes: b.notes ?? null,
            manualStop: typeof b.manualStop === "number" ? b.manualStop : null,
            setup: b.setup ?? null,
            tags: Array.isArray(b.tags) ? b.tags.map(String) : [],
            updatedAt: deps.now(),
          };
          upsertJournal(db, journal);
          // Setup/tags feed breakdowns and a manual stop feeds risk/R/flags — re-derive through the
          // single tested pipeline (no OpenD round-trip).
          await rebuildDerived(db, { candles: deps.candles, config: deps.config, now: deps.now() });
          return json(tradeDetail(db, id));
        }
        if (seg.length === 4 && seg[3] === "candles" && method === "GET") {
          const trade = allTrades(db).find((t) => t.id === id);
          if (!trade) return json({ error: "trade not found" }, 404);
          const resMs = url.searchParams.get("res") === "hour" ? 3_600_000 : DAY_MS;
          const from = trade.openTime - PAD_MS;
          const to = (trade.closeTime ?? deps.now()) + PAD_MS;
          let bars: Awaited<ReturnType<CandleSource["getCandles"]>> = [];
          try {
            bars = await deps.candles.getCandles(trade.symbol, from, to, resMs);
          } catch {
            bars = [];
          }
          return json(bars);
        }
      }
      // GET /api/positions
      if (seg.length === 2 && seg[1] === "positions" && method === "GET") {
        return json(positionsByCurrency(openPositions(db, latestSnapshotTime(db))));
      }
      // GET /api/meta
      if (seg.length === 2 && seg[1] === "meta" && method === "GET") {
        return json(metaView(db));
      }

      // /api/journal/weeks/:isoWeek  (GET + PUT); trades are associated by date at read time.
      if (seg.length === 4 && seg[1] === "journal" && seg[2] === "weeks") {
        const isoWeek = decodeURIComponent(seg[3]!);
        const { start, end } = weekRange(isoWeek);
        if (Number.isNaN(start)) return json({ error: "bad ISO week" }, 400);
        if (method === "PUT") {
          const b = (await req.json()) as any;
          const watchlist: WatchlistItem[] = Array.isArray(b.watchlist)
            ? b.watchlist.map((w: any) => ({
                symbol: String(w.symbol),
                note: w.note ?? null,
                keyLevel: typeof w.keyLevel === "number" ? w.keyLevel : null,
              }))
            : [];
          upsertWeeklyEntry(db, {
            id: isoWeek,
            periodStart: start,
            periodEnd: end,
            marketRead: b.marketRead ?? null,
            tradedVsPlan: b.tradedVsPlan ?? null,
            watchlist,
            updatedAt: deps.now(),
          });
        }
        if (method === "GET" || method === "PUT") {
          const entry = getWeeklyEntry(db, isoWeek) ?? {
            id: isoWeek,
            periodStart: start,
            periodEnd: end,
            marketRead: null,
            tradedVsPlan: null,
            watchlist: [],
            updatedAt: 0,
          };
          return json({ ...entry, trades: tradesInRange(db, start, end) });
        }
      }

      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  };
}
