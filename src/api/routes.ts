// The JSON API as a plain fetch handler: buildApi(db, deps) → (Request) => Promise<Response>.
// Kept framework-free and server-free so tests call it directly against an in-memory DB. Money
// aggregates always cross the wire under a `byCurrency` shape — never a bare top-level total.
import type { Database } from "bun:sqlite";
import type { CandleSource } from "../domain/ports";
import type { RuleConfig, Trade } from "../domain/types";
import { computeStats, breakdown } from "../core/analytics";
import { type Res, windowFor } from "../core/candle-res";
import { allTrades, flagsForTrade } from "../store/repos";
import { holdBucket, isValidIsoWeek, weekRange } from "../domain/time";
import type { Journal, WatchlistItem } from "../domain/journal-types";
import {
  getJournal,
  getWeeklyEntry,
  tradesInRange,
  upsertJournal,
  upsertWeeklyEntry,
} from "../store/journal";
import { getDrawings, upsertDrawings, type Drawing } from "../store/drawings";
import { rebuildDerived } from "../sync/sync";
import {
  latestSnapshotTime,
  metaView,
  openPositionsByCurrency,
  tradeDetail,
} from "./views";
import type { SyncRunner } from "./sync-runner";
import { Mutex } from "./mutex";

/** Coarser fallback for each intraday res, tried in order when a fetch comes back empty (e.g. the
 * trade predates Yahoo's retention at that resolution). "1d" has nothing coarser to fall back to. */
const COARSER: Record<Res, Res | null> = { "15m": "1h", "1h": "1d", "1d": null };

function parseRes(v: string | null): Res {
  return v === "1h" || v === "15m" ? v : "1d"; // unknown/absent → default 1d
}

export interface ApiDeps {
  candles: CandleSource;
  config: RuleConfig;
  sync: SyncRunner | null;
  now: () => number;
  /** Shared with the sync job so journal-triggered rebuilds serialize with a running sync's rebuild
   * (both must not overwrite each other). Defaults to a fresh mutex when omitted (tests). */
  rebuildLock?: Mutex;
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

const MAX_DRAWINGS = 200;
const MAX_DRAWINGS_BYTES = 256 * 1024;

/** A drawing point is `{timestamp?: number, value?: number}` — both optional, but if present must
 * be numbers (never coerce a wrong-typed value; reject instead). */
function validPoint(v: unknown): boolean {
  if (v === null || typeof v !== "object") return false;
  const p = v as Record<string, unknown>;
  if ("timestamp" in p && p.timestamp !== undefined && typeof p.timestamp !== "number") return false;
  if ("value" in p && p.value !== undefined && typeof p.value !== "number") return false;
  return true;
}

function validDrawing(v: unknown): boolean {
  if (v === null || typeof v !== "object") return false;
  const d = v as Record<string, unknown>;
  if (typeof d.name !== "string") return false;
  if (!Array.isArray(d.points)) return false;
  return d.points.every(validPoint);
}

/** Validate a PUT drawings body: an array of ≤200 well-shaped drawings, capped in serialized size. */
function validDrawings(v: unknown): v is Drawing[] {
  if (!Array.isArray(v)) return false;
  if (v.length > MAX_DRAWINGS) return false;
  if (!v.every(validDrawing)) return false;
  return JSON.stringify(v).length <= MAX_DRAWINGS_BYTES;
}

/** Order-insensitive equality of two tag lists (getJournal returns tags sorted; a request may not). */
function tagsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const as = [...a].sort();
  const bs = [...b].sort();
  return as.every((t, i) => t === bs[i]);
}

/** Parse a JSON request body, requiring a non-null, non-array object. Returns `null` on malformed
 * JSON or a non-object body so the caller can 400 instead of 500-ing (or silently null-overwriting). */
async function readJsonObject(req: Request): Promise<Record<string, unknown> | null> {
  let b: unknown;
  try {
    b = await req.json();
  } catch {
    return null;
  }
  if (b === null || typeof b !== "object" || Array.isArray(b)) return null;
  return b as Record<string, unknown>;
}

export function buildApi(db: Database, deps: ApiDeps): (req: Request) => Promise<Response> {
  const rebuildLock = deps.rebuildLock ?? new Mutex();
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
          const b = (await readJsonObject(req)) as any;
          if (!b) return json({ error: "body must be a JSON object" }, 400);
          if (!validScore(b.conviction) || !validScore(b.rating)) {
            return json({ error: "conviction/rating must be an integer 1..5 or null" }, 400);
          }
          // Reject a wrong-typed manual stop (e.g. the string "95" from an HTML input) rather than
          // coercing it to null — that would SILENTLY CLEAR the authoritative risk basis on a 200.
          if (b.manualStop != null && typeof b.manualStop !== "number") {
            return json({ error: "manualStop must be a number or null" }, 400);
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
          // Only manualStop/setup/tags feed derived data (risk/R/flags, breakdown keys); thesis/notes/
          // emotion/conviction/rating do not. Rebuild ONLY when a derived-affecting field changed, so a
          // routine note/rating save doesn't walk every trade + refetch candles.
          const prev = getJournal(db, id);
          const derivedChanged = prev
            ? prev.manualStop !== journal.manualStop ||
              prev.setup !== journal.setup ||
              !tagsEqual(prev.tags, journal.tags)
            : journal.manualStop !== null || journal.setup !== null || journal.tags.length > 0;
          upsertJournal(db, journal);
          if (derivedChanged) {
            // Serialized with a running sync's rebuild via the shared lock so the two can't interleave
            // and clobber each other's derived rows (no OpenD round-trip).
            await rebuildLock.runExclusive(() =>
              rebuildDerived(db, { candles: deps.candles, config: deps.config, now: deps.now() }),
            );
          }
          return json(tradeDetail(db, id));
        }
        if (seg.length === 4 && seg[3] === "drawings" && method === "GET") {
          return json({ drawings: getDrawings(db, id) });
        }
        if (seg.length === 4 && seg[3] === "drawings" && method === "PUT") {
          const b = await readJsonObject(req);
          if (!b) return json({ error: "body must be a JSON object" }, 400);
          if (!validDrawings(b.drawings)) {
            return json(
              { error: "drawings must be an array of ≤200 {name, points[, extendData]} entries" },
              400,
            );
          }
          // Drawings are user annotations, not derived data — no rebuildDerived here.
          upsertDrawings(db, id, b.drawings, deps.now());
          return json({ drawings: getDrawings(db, id) });
        }
        if (seg.length === 4 && seg[3] === "candles" && method === "GET") {
          const trade = allTrades(db).find((t) => t.id === id);
          if (!trade) return json({ error: "trade not found" }, 404);
          let res = parseRes(url.searchParams.get("res"));
          let win = windowFor(trade.openTime, trade.closeTime, deps.now(), res);
          let bars: Awaited<ReturnType<CandleSource["getCandles"]>> = [];
          // Coarsen-on-empty: an intraday res can legitimately come back empty (the trade predates
          // Yahoo's retention at that resolution) — retry one step coarser before giving up, and
          // report whichever res actually produced bars.
          for (;;) {
            try {
              bars = await deps.candles.getCandles(trade.symbol, win.fromMs, win.toMs, win.resMs);
            } catch {
              bars = [];
            }
            if (bars.length > 0) break;
            const next = COARSER[res];
            if (!next) break;
            res = next;
            win = windowFor(trade.openTime, trade.closeTime, deps.now(), res);
          }
          return json({ res, resMs: win.resMs, focusFrom: win.focusFrom, focusTo: win.focusTo, candles: bars });
        }
      }
      // GET /api/positions
      if (seg.length === 2 && seg[1] === "positions" && method === "GET") {
        return json(openPositionsByCurrency(db, latestSnapshotTime(db)));
      }
      // GET /api/meta
      if (seg.length === 2 && seg[1] === "meta" && method === "GET") {
        return json(metaView(db));
      }

      // POST /api/sync (start; 409 if already running) + GET /api/sync/status
      if (seg[1] === "sync") {
        if (!deps.sync) return json({ error: "sync unavailable" }, 503);
        if (seg.length === 2 && method === "POST") {
          const started = deps.sync.start();
          return json(deps.sync.status(), started ? 202 : 409);
        }
        if (seg.length === 3 && seg[2] === "status" && method === "GET") {
          return json(deps.sync.status());
        }
      }

      // /api/journal/weeks/:isoWeek  (GET + PUT); trades are associated by date at read time.
      if (seg.length === 4 && seg[1] === "journal" && seg[2] === "weeks") {
        const isoWeek = decodeURIComponent(seg[3]!);
        if (!isValidIsoWeek(isoWeek)) return json({ error: "bad ISO week (want canonical YYYY-Www)" }, 400);
        const { start, end } = weekRange(isoWeek);
        if (method === "PUT") {
          const b = (await readJsonObject(req)) as any;
          if (!b) return json({ error: "body must be a JSON object" }, 400);
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
