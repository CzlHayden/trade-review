# FUTU Trade Review — Design Doc

**Date:** 2026-07-10
**Status:** Draft for review
**Owners:** Keith + brother (two independent local users)

---

## 1. Overview

A local-first desktop tool that pulls a user's own trade history from FUTU, reconstructs it into reviewable **round-trip trades**, and helps the user learn from it through journaling, a marked-up chart, performance analytics, and transparent rule-based "mistake" flags.

The tool is for **self-review**, not execution. It never places orders. v1 ships **without AI**; the data layer is designed so an MCP server (for Claude-driven analysis) can be added later without a rewrite.

### The four jobs the tool serves
1. **Catch my mistakes** — rule-based flags on trade mechanics.
2. **Analyze performance** — P&L, win rate, expectancy, R-multiples, sliced by symbol / setup / hold-time.
3. **Journal my reasoning** — capture thesis, emotion, conviction, rating per trade; review decisions vs outcomes.
4. **Find my edge** — breakdowns that reveal which setups/conditions make money.

---

## 2. Users & context

- **Two users** (Keith + brother), **mostly swing / position** trading with **occasional intraday**, on FUTU.
- Each user runs their **own independent local install** with their **own FUTU account** and **own OpenD gateway**. There is **no shared/multi-tenant database** — each install is single-user. This removes all multi-user complexity from v1.
- Low trade volume per user makes **per-trade journaling practical**.
- Both have TradingView subscriptions, but TV does not expose account/layout data via API, so we render our own charts (see §7).

---

## 3. Goals & non-goals

### v1 goals
- Auto-sync trade history from FUTU (free API surface only).
- Build accurate round-trip trades from raw fills.
- Per-trade journaling with tags, conviction, rating, notes, optional manual stop.
- Marked-up chart per trade (candles + entry/exit/add markers + stop/TP lines).
- Performance dashboard with slice-and-dice breakdowns.
- Transparent, tunable rule-based mistake flags.
- Ship as a **single compiled binary** (Bun) that opens the app in the browser.
- **Never lose user-written data across updates** (stable DB location + migrations + pre-migration backup).

### Non-goals (v1)
- No AI / chat / MCP (architected for, not built).
- No real-time streaming quotes or live dashboards.
- No order placement or execution.
- No cloud hosting / multi-tenant / mobile app.
- No ATR/volatility-based risk *inference* (stops come from orders or manual entry only — see §6).

### Future (v2+)
- MCP server wrapping the store + analytics for open-ended Claude queries.
- AI-generated trade reviews and pattern insights.
- Tauri desktop packaging with signed auto-update.
- Options/derivatives-specific metrics; additional data sources.

---

## 4. Architecture

**Stack:** Bun + TypeScript for **both** backend and frontend (one language, one toolchain). SQLite for storage. React + Vite + [Lightweight Charts](https://tradingview.github.io/lightweight-charts/) for the UI. FUTU access via the official `futu-api` npm package talking to **OpenD** over its local WebSocket.

```
┌────────────────────────────── single compiled binary ──────────────────────────────┐
│                                                                                       │
│   React SPA (served as static)  ◄──HTTP/JSON──►  Bun HTTP API                          │
│   - dashboard, trades, detail                     │                                    │
│   - Lightweight Charts                            ▼                                    │
│                                    ┌───────────────────────────────┐                  │
│                                    │ core (pure logic, unit-tested) │                  │
│                                    │  trade-builder · stop-inference │                 │
│                                    │  rule-engine · analytics        │                 │
│                                    └───────────────────────────────┘                  │
│                                       ▲            ▲            ▲                       │
│                                       │            │            │                      │
│                                    store (SQLite) │        candles (OHLC)              │
│                                       ▲            │            ▲                       │
│                                       │        futu-client      │ (FUTU K-line /        │
│                                       │            │            │  yfinance fallback)   │
└───────────────────────────────────────┼───────────┼────────────┼──────────────────────┘
                                         │           ▼            │
                                         │      OpenD (localhost WebSocket)  ── internet ──► FUTU
                                         ▼
                            ~/Library/Application Support/TradeReview/  (DB + backups)
```

### Modules (each has one purpose, a clear interface, and stated dependencies)

| Module | Purpose | Key interface | Depends on |
|---|---|---|---|
| `futu-client` | Connect to OpenD; pull raw orders, fills (deals), positions, accounts | `syncOrders()`, `syncFills()`, `syncPositions()`, `getAccounts()` | `futu-api` npm, OpenD |
| `candles` | Fetch OHLC bars for a symbol/date-range/resolution | `getCandles(symbol, from, to, res)` | FUTU K-line or yfinance |
| `store` | SQLite persistence: schema, migrations, backup, repositories | repositories + `migrate()`, `backup()` | SQLite (bun:sqlite) |
| `trade-builder` | **Pure.** Fills → round-trip trades | `buildTrades(fills) → Trade[]` | none |
| `stop-inference` | **Pure.** Trade + orders → inferred stop/TP + stop-move history | `inferStops(trade, orders) → StopInfo` | none |
| `rule-engine` | **Pure.** Trade + context + config → flags | `evaluate(trade, ctx, config) → Flag[]` | none |
| `analytics` | **Pure.** Trades + filters → aggregate stats | `computeStats(trades, filters) → Stats` | none |
| `api` | Bun HTTP server exposing REST endpoints to the SPA | route handlers | store, core modules, sync |
| `sync` | Orchestrate: pull raw → rebuild trades → infer stops → recompute flags | `runSync()` | futu-client, store, core |
| `web` | React SPA: dashboard, trade list, trade detail, journal, settings | — | api |
| `app` | Bootstrap: ensure data dir, backup, migrate, start server, open browser | `main()` | all |

The four **pure** modules (`trade-builder`, `stop-inference`, `rule-engine`, `analytics`) hold all correctness-critical logic and are independently unit-testable with fixture data — no live FUTU account required to test them. These are built test-first (see §12).

---

## 5. Data model (SQLite)

Two tiers: **raw** (faithful copy of what FUTU returned, append/upsert, never mutated by logic) and **derived** (rebuildable from raw at any time). User-written data lives in its own tables and is **never** derived/overwritten.

```
raw_orders        -- every order incl. cancelled/stop/limit: id, symbol, side, type,
                     qty, price, trigger_price, status, create_time, update_time, account
raw_fills         -- executions (deals): id, order_id, symbol, side, qty, price, fee,
                     time, account
raw_positions     -- snapshot per sync: symbol, qty, avg_cost, time, account

trades            -- DERIVED round-trip: id, symbol, direction, account,
                     open_time, close_time, avg_entry, avg_exit, max_qty,
                     realized_pnl, fees, hold_seconds, status(open/closed),
                     effective_stop, effective_tp, risk, r_multiple
trade_fills       -- link table: trade_id ↔ fill_id (which fills compose a trade)
stop_events       -- DERIVED stop-move history per trade: trade_id, order_id,
                     stop_price, placed_time, cancelled_time, source(attached/inferred)

journal           -- USER-WRITTEN: trade_id, thesis, emotion, conviction(1-5),
                     rating(1-5), notes(md), manual_stop, updated_at
journal_tags      -- USER-WRITTEN: trade_id, tag (setup tags, freeform)
attachments       -- USER-WRITTEN: trade_id, file path/blob (screenshots)

flags             -- DERIVED (cached): trade_id, rule_id, severity, reason, receipts(json)
candles_cache     -- symbol, resolution, time, ohlcv
settings          -- rule toggles + thresholds, sync prefs, data-source prefs
sync_state        -- per account/market: last_synced_time
schema_version    -- single row: current migration version
```

**Rebuild safety:** `trades`, `trade_fills`, `stop_events`, `flags` can be dropped and rebuilt from `raw_*` at any time (e.g. after a logic change). `journal*`, `attachments`, `settings` are keyed by stable `trade_id` and survive rebuilds.

---

## 6. Round-trip trade building & stops

### Trade building (`trade-builder`, pure)
Process fills per **(account, symbol)** in chronological order, maintaining a running position:

- A trade **opens** when position moves from 0 → non-zero.
- Same-direction fills **add** to the open trade (scale-in).
- Opposite fills **reduce** (scale-out); trade **closes** when position returns to 0.
- A fill that **flips** through zero (e.g. long → short in one execution) is **split** into a close + a new open.
- Per trade compute: direction, weighted `avg_entry` / `avg_exit`, `max_qty`, `realized_pnl` (net of fees), `fees`, `open/close_time`, `hold_seconds`.
- Trades still open (position ≠ 0) are marked `status = open` and excluded from most performance stats.

### Stop / take-profit inference (`stop-inference`, pure)
We do **not** rely on FUTU's "attached SL" flag. We reconstruct protective orders by scanning all orders on the symbol during the trade's open window. An order is matched as protective when **all** hold:

- Same symbol, **opposite side** to the position (long → SELL; short → BUY).
- **Stop / stop-limit / trailing-stop** → stop-loss; **limit** beyond market on the profit side → take-profit.
- Quantity **≤** open position size (reducing, not opening).
- Placed **after** entry and while the position was open.

Outputs:
- `effective_stop` / `effective_tp` = the last active matched order of each kind.
- `stop_events` = full history of placements/cancellations (surfaces **stop moves** — e.g. "trailed stop up 3×").
- Each match records **receipts** ("SELL STOP 100 @ $95, placed 2d after entry, while long 100") and can be **confirmed / unlinked** by the user in the UI.

Handles both cases the user raised: (1) SL attached to entry order, and (2) a **separate** stop order placed manually — both matched by the fingerprint. A purely mental stop is unmatchable → falls back to the optional `manual_stop` journal field or blank.

### Risk & R-multiple
`risk = |avg_entry − effective_stop| × size`; `r_multiple = realized_pnl / risk`. Computed only when a stop is known (from orders or `manual_stop`). Otherwise `risk`/`r_multiple` are `null` and R-dependent stats/flags simply don't apply to that trade (graceful degradation). **No ATR/volatility inference in v1.**

---

## 7. Charts (`candles` + web)

Rendered with **Lightweight Charts** (TradingView's open-source engine; we supply the data):

- **Candles:** daily resolution by default; intraday resolution for intraday trades. Source order: try FUTU K-line, fall back to a free source (yfinance-equivalent) if quota/quote-rights block it. Cached in `candles_cache`.
- **Markers:** each fill plotted as a marker (buy = up-arrow below bar, sell = down-arrow above bar), sized/labeled by qty. Adds and scale-outs are distinct markers.
- **Price lines:** horizontal lines for `avg_entry`, `effective_stop`, `effective_tp`.
- Time range padded around the trade's open/close window.

The generic TradingView embed widget is **not** used (it's a sealed iframe that can't render our fills).

---

## 8. Rule engine (`rule-engine`, pure)

Each rule is a deterministic predicate over a trade (+ recent-trade context). Firing stamps a `flag` with a plain-English `reason` and structured `receipts`. All rules are **toggleable** and thresholds are **tunable** in settings.

| Rule id | Fires when | Needs |
|---|---|---|
| `added_to_loser` | Size increased while position was underwater | fills only |
| `cut_winner_early` | Exited green for `< 1R` gain | fills + risk |
| `held_past_stop` | Worst point / exit went beyond the known stop | fills + stop |
| `oversized` | Trade risk `> threshold×` (default 1.5) rolling avg risk | fills + history |
| `round_tripped_gain` | Peak unrealized gain `≥ threshold`, exited flat/red | fills + candles |
| `overtrading_revenge` | New trade opened within `X` min of closing a loser | fill timestamps |

Rules needing data that's absent (e.g. no stop) are **skipped** for that trade, not errored. Every flag shows *why* it fired and can be dismissed as a false positive.

---

## 9. Sync flow (`sync`)

1. Connect to OpenD (error clearly if not running / not logged in — see §11).
2. Pull historical **orders**, **fills**, and current **positions** since `sync_state.last_synced_time` per account/market; **upsert** into `raw_*`.
3. Rebuild derived data idempotently: `buildTrades` → `inferStops` → `rule-engine.evaluate` → write `trades`, `trade_fills`, `stop_events`, `flags`.
4. Update `sync_state`.

Triggered by a **"Sync now"** button and optionally on app startup. Idempotent: re-running never duplicates trades.

---

## 10. Frontend (`web`)

- **Dashboard:** KPI cards (net P&L, win rate, expectancy, avg R, trade count), equity curve, breakdowns by setup-tag / symbol / hold-time bucket, and a "flagged trades" list.
- **Trades list:** filterable/sortable table (by symbol, tag, flag, date, P&L, R).
- **Trade detail:** the marked-up chart, trade stats, **journal editor** (thesis, emotion, conviction, rating, notes, tags, manual stop), **flags with reasons**, and **stop panel** (auto-detected stop with receipts + confirm/unlink).
- **Settings:** rule toggles/thresholds, sync preferences, candle data-source preference.

UI polish is secondary to correctness for v1, but the React stack leaves room to make it good.

---

## 11. Error handling

- **OpenD not running / not logged in:** detect connection failure; show an actionable banner ("Start OpenD and log in to sync") rather than a stack trace. App remains usable in read-only mode against existing DB.
- **Candle fetch fails / quota:** fall back to the free source; if both fail, render the chart with fills but no candle background and note it.
- **Rate limits / partial sync:** retry with backoff; always show "last successful sync" time; never leave `raw_*` half-written (transactional upserts).
- **Migration failure:** restore from the pre-migration backup and surface the error (see §13).

---

## 12. Testing strategy

- **Unit (TDD, primary):** the four pure modules. `trade-builder` gets a fixture suite covering scale-in, scale-out, partial close, flip-through-zero, multiple concurrent symbols, still-open trades. `stop-inference` covers attached SL, separate SL order, stop moves, ambiguous/none. `rule-engine` covers each rule firing and correctly *not* firing. `analytics` covers stat math incl. empty/edge inputs.
- **Integration:** `store` migrations (v_n → v_n+1 preserves data); `sync` end-to-end against recorded fixture payloads (no live account needed).
- **Manual:** `futu-client` against a real OpenD during development.
- **Fixtures:** checked-in sample orders/fills JSON so the whole derived pipeline is testable offline.

---

## 13. Packaging, updates & data safety

### Packaging
- `bun build --compile` → **single executable** per target (macOS arm64, Windows x64; cross-compiled from the dev machine). The built React assets are embedded and served as static files.
- On launch, `app.main()`: ensure data dir exists → **backup DB** → run **migrations** → start server on a localhost port → open the default browser to the app.
- The brother's total setup: **(1)** download & log into **OpenD** (FUTU's free gateway, one-time, documented with screenshots), **(2)** double-click the binary. He does **not** install Bun/Node/anything else.

### Updates
- **v1:** manual hand-off of the new binary (AirDrop/Drive), replace the old file.
- **v1.x (fast-follow):** GitHub Releases + a startup version check that notifies ("v1.3 available") and optionally self-replaces the binary.
- **v2 option:** Tauri packaging with built-in signed auto-update.

### Data safety across updates (hard requirement)
- The SQLite DB lives in a **stable user-data folder** (`~/Library/Application Support/TradeReview/` on macOS; platform equivalent on Windows), **never** next to the binary. Replacing the binary cannot touch it.
- **Migrations** run automatically on startup, tracked by `schema_version`. Migrations only **add** structure; they never drop or clear user-written data.
- The DB is **auto-copied to a timestamped backup** immediately before any migration, so a bad migration is always recoverable.

Analogy for users: the binary is the *program*, the DB is the *save file*; updating the program never touches the save file.

---

## 14. Open questions to resolve in planning

1. **Candle default source** — FUTU K-line first vs. yfinance-equivalent first (quota vs. data quality tradeoff).
2. **Which markets/accounts** in scope initially (US + HK, or whatever OpenD returns for the logged-in account).
3. **Intraday candle depth** — free fallback sources cap intraday history (~60 days of 1-min); acceptable for v1?
4. **Exact localhost port + browser-open behavior** across macOS/Windows.
5. **Manual-stop UX** — where/when the user enters a mental stop (journal field vs. inline on the stop panel).
```
