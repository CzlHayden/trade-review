# FUTU Trade Review — Design Doc

**Date:** 2026-07-10
**Status:** Draft for review (rev 2 — incorporates journaling model + Fable review)
**Owners:** Keith + brother (two independent local users)

---

## 1. Overview

A local-first desktop tool that pulls a user's own trade history from FUTU, reconstructs it into reviewable **round-trip trades**, and helps the user learn from it through journaling (per-trade **and** weekly), a marked-up chart, performance analytics, and transparent rule-based "mistake" flags.

The tool is for **self-review**, not execution. It never places orders. v1 ships **without AI**; the data layer is designed so an MCP server (for Claude-driven analysis) can be added later without a rewrite.

### The four jobs the tool serves
1. **Catch my mistakes** — rule-based flags on trade mechanics.
2. **Analyze performance** — P&L, win rate, expectancy, R-multiples, MAE/MFE, sliced by symbol / setup / hold-time.
3. **Journal my reasoning** — capture thesis, emotion, conviction, rating, setup + tags per trade; a weekly market-view entry; review decisions vs. outcomes.
4. **Find my edge** — breakdowns (by setup/tag) that reveal which conditions make money.

---

## 2. Users & context

- **Two users** (Keith + brother), **mostly swing / position** trading with **occasional intraday**, on FUTU.
- Each user runs their **own independent local install** with their **own FUTU account** and **own OpenD gateway**. There is **no shared/multi-tenant database** — each install is single-user. This removes all multi-user complexity from v1.
- Low trade volume per user makes **per-trade journaling practical**, and the natural review cadence is **weekly**.
- Both may trade **US and HK** markets → P&L is **multi-currency** (see §5, §7).
- Both have TradingView subscriptions, but TV does not expose account/layout data via API, so we render our own charts (§8).

---

## 3. Goals & non-goals

### v1 goals
- Auto-sync trade history from FUTU (free API surface only).
- Build accurate round-trip trades from raw fills (currency-aware; robust to pre-existing positions).
- Per-trade journaling: thesis, emotion, conviction, rating, notes, optional manual stop, a single **setup** field + freeform **tags**.
- Optional **weekly journal entry**: market read + simple watchlist + "traded vs. plan" notes, auto-associating that week's trades.
- Marked-up chart per trade (candles + entry/exit/add markers + stop/TP lines).
- Performance dashboard, **segmented by currency**, with slice-and-dice breakdowns; **MAE/MFE** per trade.
- **Open-positions view** (current holdings + open risk).
- Transparent rule-based mistake flags (defaults hardcoded + config file; no settings UI in v1).
- Ship as a **single compiled binary** (Bun) that opens the app in the browser.
- **Never lose user-written data across updates** (stable DB location + migrations + pre-migration backup).

### Non-goals (v1) — deliberately cut for simplicity
- No AI / chat / MCP (architected for, not built).
- No real-time streaming quotes; no order placement.
- No cloud hosting / multi-tenant / mobile app.
- No ATR/volatility-based risk *inference* (stops come from orders or manual entry only).
- **Single candle source** only (no dual-source fallback).
- **No stop-move history / confirm-unlink UI** (infer `effective_stop` + manual override only).
- **No settings UI** (hardcoded defaults + config file).
- **No self-updating binary** (manual AirDrop/Drive hand-off).
- No auto-handling of splits/corporate actions (detect + flag only — §6).
- Journaling deferred: daily entries, watchlist-vs-trades comparison, formal thesis/campaign objects, setup rule-checklists + adherence scoring.

### Future (v2+)
- MCP server wrapping the store + analytics for Claude queries; AI-generated reviews.
- Stop-move history + management UI; settings page; GitHub-Releases auto-update; Tauri desktop packaging.
- Daily journal, watchlist-vs-trades comparison, thesis/campaign objects, setup rule-checklists + adherence, FUTU K-line as a second candle source, options metrics.

---

## 4. Architecture

**Stack:** Bun + TypeScript for **both** backend and frontend (one language, one toolchain). SQLite for storage. React + Vite + [Lightweight Charts](https://tradingview.github.io/lightweight-charts/) for the UI. FUTU access via the official `futu-api` npm package talking to **OpenD** over its local WebSocket.

```
┌────────────────────────────── single compiled binary ──────────────────────────────┐
│   React SPA (served as static)  ◄──HTTP/JSON──►  Bun HTTP API                          │
│   - dashboard, trades, detail,                    │                                    │
│     open positions, weekly journal                ▼                                    │
│                                    ┌───────────────────────────────┐                  │
│                                    │ core (pure logic, unit-tested) │                  │
│                                    │  trade-builder · stop-inference │                 │
│                                    │  rule-engine · analytics · mae-mfe │              │
│                                    └───────────────────────────────┘                  │
│                                       ▲            ▲            ▲                       │
│                                    store (SQLite) │        candles (single source)     │
│                                       ▲        futu-client      ▲                       │
└───────────────────────────────────────┼───────────┼────────────┼──────────────────────┘
                                         │           ▼            │
                                         │      OpenD (localhost WebSocket) ── internet ──► FUTU
                                         ▼
                            <user-data-dir>/TradeReview/  (DB + backups + config)
```

### Modules (each: one purpose, clear interface, stated dependencies)

| Module | Purpose | Key interface | Depends on |
|---|---|---|---|
| `futu-client` | Connect to OpenD; pull raw orders, fills, positions, accounts (chunked, paced) | `syncOrders()`, `syncFills()`, `syncPositions()`, `getAccounts()` | `futu-api` npm, OpenD |
| `candles` | Fetch OHLC bars for a symbol/date-range/resolution (single free source) | `getCandles(symbol, from, to, res)` | free data source |
| `store` | SQLite persistence: schema, migrations, backup, config, repositories | repositories + `migrate()`, `backup()`, `getConfig()` | bun:sqlite |
| `trade-builder` | **Pure.** Fills (+ seed positions) → round-trip trades | `buildTrades(fills, seedPositions) → Trade[]` | none |
| `stop-inference` | **Pure.** Trade + orders → `effective_stop`/`effective_tp` | `inferStops(trade, orders) → StopInfo` | none |
| `mae-mfe` | **Pure.** Trade + candles → max adverse/favorable excursion | `computeExcursion(trade, candles) → {mae, mfe}` | none |
| `rule-engine` | **Pure.** Trade + context + config → flags | `evaluate(trade, ctx, config) → Flag[]` | none |
| `analytics` | **Pure.** Trades + filters → aggregate stats (currency-aware) | `computeStats(trades, filters) → Stats` | none |
| `api` | Bun HTTP server exposing REST endpoints to the SPA | route handlers | store, core, sync |
| `sync` | Orchestrate: pull raw → rebuild trades → infer stops → excursions → flags | `runSync()` | futu-client, candles, store, core |
| `web` | React SPA: dashboard, trades, detail, open positions, weekly journal | — | api |
| `app` | Bootstrap: ensure data dir, backup, migrate, start server, open browser | `main()` | all |

The **pure** modules hold all correctness-critical logic and are unit-testable with fixture data — no live FUTU account required. Built test-first (§13).

---

## 5. Data model (SQLite)

Two tiers: **raw** (faithful copy of FUTU output, upsert, never mutated by logic) and **derived** (rebuildable from raw). User-written data lives in its own tables and is **never** overwritten by rebuilds.

```
raw_orders     -- every order incl. cancelled/stop/limit: id, symbol, side, type, qty,
                  price, trigger_price, status, currency, create_time, update_time, account
raw_fills      -- executions (deals): id, order_id, symbol, side, qty, price, fee,
                  currency, time, account
raw_positions  -- snapshot per sync: symbol, qty, avg_cost, currency, time, account

trades         -- DERIVED round-trip: id, symbol, currency, direction, account,
                  open_time, close_time, avg_entry, avg_exit, max_qty, realized_pnl, fees,
                  hold_seconds, status(open/closed), effective_stop, effective_tp,
                  risk, r_multiple, mae, mfe, coverage_ok(bool)
trade_fills    -- link: trade_id ↔ fill_id

journal        -- USER-WRITTEN: trade_id, thesis, emotion, conviction(1-5), rating(1-5),
                  notes(md), manual_stop, setup, updated_at
journal_tags   -- USER-WRITTEN: trade_id, tag (freeform, multi)
attachments    -- USER-WRITTEN: trade_id, path/blob (screenshots)

journal_entries      -- USER-WRITTEN weekly (or dated) entry: id, period_start, period_end,
                        market_read(md), traded_vs_plan(md), updated_at
watchlist_items      -- USER-WRITTEN: entry_id, symbol, note, key_level

flags          -- DERIVED (cached): trade_id, rule_id, severity, reason, receipts(json)
candles_cache  -- symbol, resolution, time, ohlcv
config         -- rule thresholds + toggles + prefs (JSON; edited via file, no UI in v1)
sync_state     -- per account/market: last_synced_time, coverage_start
schema_version -- single row: current migration version
```

**Rebuild safety:** `trades`, `trade_fills`, `flags` (and derived stop/excursion fields) can be dropped and rebuilt from `raw_*`. `journal*`, `journal_entries`, `watchlist_items`, `attachments`, `config` are keyed by stable ids and survive rebuilds.

**Weekly ↔ trade linking:** `journal_entries` are **not** manually linked to trades. The UI joins by date — a weekly entry's page shows every trade whose `open_time`/`close_time` falls in `[period_start, period_end]`. Zero manual linking.

**Multi-currency:** every trade carries a `currency`. The dashboard shows P&L/stats **segmented per currency** (no FX conversion in v1); an optional single manual FX rate in `config` can render a combined figure if desired.

---

## 6. Round-trip trade building & stops

### Trade building (`trade-builder`, pure)
Process fills per **(account, symbol)** chronologically, maintaining a running position:

- Trade **opens** 0 → non-zero; same-direction fills **add**; opposite fills **reduce**; **closes** at return to 0.
- A fill that **flips** through zero is **split** into a close + new open.
- Per trade: direction, weighted `avg_entry`/`avg_exit`, `max_qty`, `realized_pnl` (net fees), `fees`, times, `hold_seconds`, `currency`.
- Open trades (`status=open`) are excluded from most performance stats.

**Robustness (Fable risks):**
- **Pre-existing positions:** if history starts mid-position, seed the running position from the `raw_positions` snapshot at sync start. Trades whose open predates data coverage are marked `coverage_ok=false` and **excluded from stats**.
- **Splits/corporate actions:** detect via position-math mismatch (qty changes without corresponding fills) and **flag for manual review**; no auto-adjustment in v1.

### Stop / take-profit inference (`stop-inference`, pure)
Reconstruct the protective order by scanning all orders on the symbol during the trade's open window. An order matches when **all** hold: same symbol; **opposite side**; stop/stop-limit/trailing → stop-loss, or limit beyond market on the profit side → take-profit; qty ≤ open size; placed after entry while open.

- Output `effective_stop` / `effective_tp` = the last active matched order of each kind, with a plain-English receipt.
- Covers both cases: SL attached to entry, **and** a separate manually-placed stop order.
- A purely mental stop → falls back to the optional `manual_stop` field or blank.
- **v1 scope:** no stop-move *history* table and no confirm/unlink UI (deferred). Just the inferred effective stop + manual override.

### Risk & R-multiple / excursion
`risk = |avg_entry − effective_stop| × size`; `r_multiple = realized_pnl / risk`. Computed only when a stop is known; otherwise `null` and R-dependent stats/flags don't apply (graceful). **MAE/MFE** (`mae-mfe`, pure) uses the trade-window candles already fetched for the chart (approximate at daily resolution, still valuable).

---

## 7. Analytics (`analytics`, pure)

Aggregate over closed round-trip trades, **currency-aware** (grouped per currency; open trades excluded):

- KPIs: net P&L, win rate, expectancy `= (win% × avg win) − (loss% × avg loss)`, avg R, trade count, equity curve.
- Excursion stats: avg MAE/MFE (stop-placement & early-exit insight).
- Breakdowns grouped by **setup**, **tag**, **symbol**, and **hold-time bucket** → the "find my edge" view (e.g. `breakout: +$4.2k, 61% win, 1.4R` vs `earnings: −$900`).

---

## 8. Charts (`candles` + web)

Rendered with **Lightweight Charts** (we supply the data):

- **Candles:** daily by default; intraday resolution for intraday trades. **Single free data source** in v1 (daily bars are sufficient for swing/position). Cached in `candles_cache`.
- **Markers:** each fill as a marker (buy = up-arrow below, sell = down-arrow above), distinct for adds/scale-outs.
- **Price lines:** `avg_entry`, `effective_stop`, `effective_tp`.
- Time range padded around the trade window (also the window used for MAE/MFE).

---

## 9. Rule engine (`rule-engine`, pure)

Deterministic predicates over a trade (+ recent-trade context). Firing stamps a `flag` with a plain-English `reason` + structured `receipts`. **Defaults hardcoded; thresholds/toggles read from `config` file — no settings UI in v1.**

| Rule id | Fires when | Needs |
|---|---|---|
| `added_to_loser` | Size increased while position underwater | fills |
| `cut_winner_early` | Exited green for `< 1R` gain | fills + risk |
| `held_past_stop` | Worst point / exit beyond the known stop | fills + stop |
| `oversized` | Trade risk `> 1.5×` rolling avg risk | fills + history |
| `round_tripped_gain` | Peak unrealized gain `≥ threshold`, exited flat/red | fills + candles |
| `overtrading_revenge` | New trade opened within `X` min of closing a loser | fill timestamps |

Rules needing absent data are **skipped** for that trade, not errored. Each flag shows *why* it fired.

---

## 10. Journaling model (multi-level)

Two independent levels that link by date — use one, both, or neither:

1. **Per-trade note** *(always available)* — thesis, emotion, conviction (1-5), rating (1-5), notes, optional manual stop, one **setup** (single-select, reusable list) + **tags** (freeform multi-select). Setup drives clean "by setup" analytics; tags stay flexible for mistakes/themes/conditions.
2. **Weekly journal entry** *(optional)* — `market_read`, a simple **watchlist** (tickers + note + key level), and `traded_vs_plan`. Auto-associates that week's trades by date (§5). This is the home of the market-analysis the swing cadence needs.

Deferred: daily entries, watchlist-vs-trades comparison, thesis/campaign objects, setup rule-checklists + adherence scoring.

---

## 11. Frontend (`web`)

- **Dashboard:** currency-segmented KPI cards, equity curve, breakdowns by setup/tag/symbol/hold-time, flagged-trades list.
- **Trades list:** filterable/sortable (symbol, setup, tag, flag, date, P&L, R).
- **Trade detail:** marked-up chart, stats (incl. R, MAE/MFE), journal editor (thesis/emotion/conviction/rating/notes/manual stop/setup/tags), flags with reasons, inferred-stop panel.
- **Open positions:** current holdings — symbol, size, entry, current stop, open risk.
- **Weekly journal:** the dated entry (market read + watchlist + traded-vs-plan) with that week's trades listed alongside.

UI polish is secondary to correctness for v1; the React stack leaves room to make it good.

---

## 12. Sync flow (`sync`) & error handling

1. Connect to OpenD; if not running / not logged in, show an actionable banner and stay **read-only** against the existing DB.
2. Pull historical **orders**, **fills**, **positions** since `sync_state` — **chunked and paced** to respect FUTU's windowed/rate-limited history; record `coverage_start`; surface "history starts at X" in the UI.
3. Rebuild derived data idempotently: `buildTrades` (seeded from positions) → `inferStops` → `mae-mfe` → `rule-engine` → write `trades`, `trade_fills`, `flags`.
4. Update `sync_state`.

Triggered by a **"Sync now"** button and optionally on startup. Idempotent; transactional upserts (never half-written `raw_*`). Candle-fetch failure → render chart with fills but no candles and note it. Migration failure → restore from pre-migration backup.

---

## 13. Testing strategy

- **Unit (TDD, primary):** the pure modules. `trade-builder` fixtures: scale-in, scale-out, partial close, flip-through-zero, multi-symbol, still-open, **pre-existing/seeded position**, **split mismatch**. `stop-inference`: attached SL, separate SL order, none. `rule-engine`: each rule fires / correctly doesn't. `analytics`: stat math incl. **multi-currency** and empty inputs. `mae-mfe`: excursion math.
- **Integration:** `store` migrations (v_n → v_n+1 preserves user data); `sync` end-to-end against recorded fixture payloads (offline).
- **Manual:** `futu-client` against a real OpenD.
- **Fixtures:** checked-in sample orders/fills JSON so the whole derived pipeline is testable offline.

---

## 14. Packaging, updates & data safety

### Packaging
- `bun build --compile` → **single executable** per target (macOS arm64, Windows x64; cross-compiled). Built React assets embedded and served static.
- On launch, `app.main()`: ensure data dir → **backup DB** → run **migrations** → start localhost server → open browser.
- Brother's total setup: **(1)** download & log into **OpenD** (FUTU's free gateway, one-time, documented with screenshots — note it needs periodic re-login/2FA), **(2)** double-click the binary. No Bun/Node install.

### Updates
- **v1:** manual hand-off (AirDrop/Drive), replace the old binary. (Self-update deferred.)

### Data safety across updates (hard requirement)
- DB lives in a **stable user-data folder** (`~/Library/Application Support/TradeReview/` on macOS; platform equivalent on Windows), **never** next to the binary.
- **Migrations** run automatically on startup (tracked by `schema_version`), only ever **adding** structure; never drop/clear user data.
- DB **auto-copied to a timestamped backup** immediately before any migration.

Analogy: the binary is the *program*, the DB is the *save file*; updating the program never touches the save file.

---

## 15. Build order (de-risk first)

1. **Spike (day one, before anything else):** prove `futu-api` npm can pull real orders/fills through a **`bun build --compile` binary on both macOS and Windows**. If it fails under Bun's compile target, fall back to Node runtime or a tiny Python sidecar. **Do not build features until this is proven.**
2. `store` + migrations + backup; fixtures.
3. Pure core: `trade-builder` → `stop-inference` → `mae-mfe` → `rule-engine` → `analytics` (all TDD).
4. `sync` orchestration against fixtures, then live OpenD.
5. `api` + `web`: trades list → trade detail + chart → dashboard → open positions → weekly journal.
6. Packaging + setup docs.

---

## 16. Open questions to resolve in planning

1. **Which single candle source** (free, daily + some intraday; e.g. yfinance-equivalent) — confirm coverage for US + HK symbols.
2. **Markets/accounts** in scope initially (US + HK, or whatever OpenD returns).
3. **Intraday candle depth** — free sources cap intraday history (~60 days of 1-min); acceptable for v1?
4. **Localhost port + browser-open behavior** across macOS/Windows.
5. **Config-file location/format** for rule thresholds (since there's no settings UI in v1).
```
