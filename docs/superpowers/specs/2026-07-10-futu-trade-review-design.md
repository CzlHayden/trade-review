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
- **Self-update** via GitHub Releases (check on startup → download → swap binary). Free; see §14.
- **Never lose user-written data across updates** (stable DB location + migrations + pre-migration backup).

### Non-goals (v1) — deliberately cut for simplicity
- No AI / chat / MCP (architected for, not built).
- No real-time streaming quotes; no order placement.
- No cloud hosting / multi-tenant / mobile app.
- No ATR/volatility-based risk *inference* (stops come from orders or manual entry only).
- **Single candle source** only (no dual-source fallback).
- **No stop-move history / confirm-unlink UI** (infer `effective_stop` + manual override only).
- **No settings UI** (hardcoded defaults + config file).
- No auto-handling of splits/corporate actions (detect + flag only — §6).
- Journaling deferred: daily entries, watchlist-vs-trades comparison, formal thesis/campaign objects, setup rule-checklists + adherence scoring.

### Future (v2+)
- MCP server wrapping the store + analytics for Claude queries; AI-generated reviews.
- Stop-move history + management UI; settings page; Tauri desktop packaging; real code-signing (removes macOS Gatekeeper friction).
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

**Renderer vs. data (avoid confusion):** the **renderer** is Lightweight Charts (TradingView's open-source engine — we draw our own chart so we can overlay *your* fills/stops). The **data** is OHLC candles from a **single source** in v1. These are independent choices. The TradingView **iframe widget** is deliberately *not* used: it's a sealed embed showing TV's own data and cannot draw your trades on it — losing the overlay would defeat the review chart's purpose.

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

### Updates (self-update, v1)
- On startup the app checks the **GitHub Releases API** for a newer version; if found, it notifies, downloads the new binary, and swaps itself (relaunch). Free — no server/paid service.
- **Repo:** public repo (simple public download URLs), **private data** — trades/journal live only in the local DB, never in the repo.
- **macOS Gatekeeper:** downloaded unsigned binaries are quarantined; first launch/update needs a right-click-open or quarantine-strip step — documented in setup. Real code-signing (removes this) is deferred (needs a paid Apple Developer account).
- Manual hand-off (AirDrop) remains the fallback if a self-update fails.

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
6. Packaging + **self-update** (GitHub Releases check/download/swap) + setup docs.

---

## 16. Open questions to resolve in planning

1. **Which single candle source** (free, daily + some intraday; e.g. yfinance-equivalent) — confirm coverage for US + HK symbols.
2. **Markets/accounts** in scope initially (US + HK, or whatever OpenD returns).
3. **Intraday candle depth** — free sources cap intraday history (~60 days of 1-min); acceptable for v1?
4. **Localhost port + browser-open behavior** across macOS/Windows.
5. **Config-file location/format** for rule thresholds (since there's no settings UI in v1).

**Resolved:** Release repo = **public** (zero token setup, free self-update; only code is public, never data).

---

## Spike Result (2026-07-10)

**FINAL VERDICT (Round 3): ✅ PASS / GO — the all-Bun stack is confirmed. No fallback to Node or a Python sidecar is needed.**

Round 3 (2026-07-10): with OpenD's `websocket_port` set to **33334** and a **user-chosen WebSocket Auth Key** typed into the GUI (not auto-generate), the spike authenticated and pulled real data over WebSocket — **and the `bun build --compile` binary behaved identically.** Confirmed:
- `bun run src/futu/spike.ts` → `登录成功`, `Trd_GetAccList` `retType: 0` (real account `trdEnv: 1` + sim accounts), `Trd_GetHistoryOrderFillList` `retType: 0`.
- `bun build src/futu/spike.ts --compile` → the standalone binary produced **identical** output (login + both queries `retType: 0`). This was the critical unknown; it passes.

**Required OpenD config for the app to connect (for setup docs + Plan 4):**
- Enable **`websocket_port`** (e.g. `33334`) — distinct from `api_port` (`33333`).
- Set a **WebSocket Auth Key** to a **known value** (do NOT leave it auto-generate, or it isn't reproducible). Each user picks their own; the value lives in the app's local config in the user-data dir, **never** committed to the (public) repo.
- SSL left off for localhost.
- Client connects with `ftWebsocket.start(ip, wsPort, false, authKey)` (default import: `import ftWebsocket from "futu-api"`; SDK MD5-hashes the plaintext key internally).

Earlier rounds below are kept for the debugging trail.

**Prior verdict (Round 2): BLOCKED on the WebSocket auth key — resolved in Round 3 by setting a known key.** After enabling OpenD's `websocket_port` (33334), the WebSocket connected and completed its handshake, but OpenD **rejected the `InitConnect` with `retType: -1`** because a WebSocket auth key was being enforced (key field set to "auto-generate"). The generated key is displayed **only in the OpenD GUI's WebSocket settings** — not written to any readable config file, log, or keychain on disk (verified). Fixed by typing a known key and passing it via `OPEND_WS_KEY=<key>`.

### Round 1 — what was tried (port 33333, the wrong port)

- `bun add futu-api` → installed `futu-api@10.8.6808` cleanly (one blocked postinstall from `protobufjs`, which is just a benign version-scheme warning script — not required).
- Read `node_modules/futu-api/{README.md,main.js,base.js,proto/*.proto}` directly (the README itself is a thin install-instructions page with no API docs). Confirmed via source:
  - `futu-api` is a **WebSocket-only** client. `base.js` opens `new WebSocket(this.wsuri)` with `wsuri` built as `ws://ip:port` (or `wss://` if `ssl=true`). There is no raw-TCP/`net.Socket` code path anywhere in the package.
  - `import ftWebsocket from "futu-api"` is the correct import — it's a **default** export, not named (the plan's sketch code, `import { ftWebsocket } from "futu-api"`, is wrong and throws `SyntaxError: Export named 'ftWebsocket' not found` under Bun; `main.js` only has `export const ftCmdID` and `export default ftWebsocket`).
- Wrote `src/futu/spike.ts`, ran `OPEND_PORT=33333 bun run src/futu/spike.ts`.
- Result: `ws.start(HOST, PORT, false)` → immediate `ErrorEvent`: `"WebSocket connection to 'ws://127.0.0.1:33333/' failed: Connection ended"`, followed by `CloseEvent` code `1006` (abnormal closure, no HTTP response at all). `onlogin(false, ...)` never even fires cleanly — the underlying `WebSocket` fails before the `InitConnect` handshake can be sent.
- Verified independently with a raw `nc` HTTP Upgrade request to `127.0.0.1:33333` — OpenD returned **nothing** (connection closed with no bytes), confirming port 33333 does not speak HTTP/WebSocket at all.
- Root cause found in OpenD's live config, `~/.com.futunn.FutuOpenD/UI/OpenD.xml`:
  ```xml
  <api_port>33333</api_port>
  ...
  <websocket_ip>127.0.0.1</websocket_ip>
  ```
  There is **no `<websocket_port>` entry**. Per OpenD's own shipped sample config (`FutuOpenD.xml`), `websocket_port` is commented out by default with the note *"WebSocket listening port. WebSocket will not work if not set."* Port 33333 is the **`api_port`** — the native protobuf-over-TCP port used by FUTU's C++/Python/Go/Java SDKs, a completely different protocol from the JS SDK's WebSocket transport. `lsof -p <OpenD PID>` confirms exactly one local listening port (33333); no separate WebSocket port is up anywhere.

This is exactly the failure mode anticipated in the task brief's hypothesis: *"port 33333 speaks the native protobuf-over-TCP protocol, not WebSocket."* Confirmed precisely.

### Real method names discovered (for when unblocked)

Confirmed by reading `node_modules/futu-api/main.js` and the `.proto` files directly (not guessed):

- Connect: `new ftWebsocket()`, then `ws.onlogin = (ok, msg) => {...}`, `ws.start(ip, port, ssl, key?)` — `key` (optional) is the plaintext WebSocket key; the SDK MD5-hashes it internally before sending, so pass the plaintext GUI key if one is ever configured.
- List accounts: `ws.GetAccList({ c2s: { userID: 0 } })` → wraps cmd `Trd_GetAccList` (2001). Response shape: `{ retType, retMsg, errCode, s2c: { accList: TrdAcc[] } }`.
- Historical fills: `ws.GetHistoryOrderFillList({ c2s: { header: { trdEnv, accID, trdMarket }, filterConditions: { beginTime, endTime } } })` → wraps cmd `Trd_GetHistoryOrderFillList` (2222). Response shape: `{ retType, retMsg, errCode, s2c: { header, orderFillList: OrderFill[] } }`. `beginTime`/`endTime` must be `"YYYY-MM-DD HH:MM:SS"` strings; required for historical queries.
- (Also present, useful later: `Trd_GetOrderFillList` (today's fills only), `Trd_GetHistoryOrderList` (2221), `Trd_GetOrderList` (2201), `Trd_GetPositionList` (2102), `Trd_GetFunds` (2101), `Trd_UnlockTrade` (2005, NOT used in this spike per the read-only guardrail).)
- Every call returns an already-decoded plain JS object (the SDK does the protobuf encode/decode internally) — callers never touch raw buffers directly.

### Real field names discovered (from `.proto` source, for `futu-client` in Plan 4)

`Trd_Common.TrdAcc` (account list rows):
`trdEnv` (0=Simulate, 1=Real), `accID` (uint64), `trdMarketAuthList` (int[], see `TrdMarket` enum: 1=HK, 2=US, 3=CN, 4=HKCC, 5=Futures, 6=SG...), `accType`, `cardNum`, `securityFirm`, `simAccType`, `uniCardNum`, `accStatus`, `accRole`, `jpAccType`, `competitionAccName`.

`Trd_Common.OrderFill` (historical fill rows — the `RawFill` source):
`trdSide` (buy/sell enum), `fillID` (uint64, required), `fillIDEx` (string), `orderID` (uint64), `orderIDEx` (string), `code` (string, required), `name` (string, required), `qty` (double, required), `price` (double, required), `createTime` (string `"YYYY-MM-DD HH:MM:SS[.ms]"`, required — the fill timestamp), `counterBrokerID`, `counterBrokerName`, `secMarket`, `createTimestamp` (double, unix-ish), `updateTimestamp`, `status` (`OrderFillStatus` enum), `trdMarket`, `jpAccType`.

`Trd_Common.TrdHeader` (required wrapper for all account-scoped trade calls): `trdEnv`, `accID`, `trdMarket`, `jpAccType`.

`Trd_Common.TrdFilterConditions` (historical query filter): `codeList[]`, `idList[]` (uint64 — orderID for orders, fillID for fills), `beginTime`, `endTime`, `orderIDExList[]`, `filterMarket`.

### Round 1 recommendation (superseded by Round 2 below)

1. In the FUTU OpenD GUI, set a **WebSocket port** (e.g. `33334`, distinct from `api_port` 33333) under the WebSocket section, and restart OpenD. — **Done in Round 2.** (Note: the earlier claim here that "a WebSocket key is optional" turned out to be wrong when the GUI's key was set to auto-generate — see Round 2.)
2. Re-run the spike against the new port — **Done in Round 2.**
3. Fallback if WebSocket can't be used at all (spec §15): Node runtime, or a Python sidecar using FUTU's native TCP SDK against `api_port` 33333.

---

### Round 2 — WebSocket port live (33334); connects, but auth key required

**Setup at this point:** OpenD's live config (`~/.com.futunn.FutuOpenD/UI/OpenD.xml`) now has `<websocket_port>33334</websocket_port>` alongside `<api_port>33333</api_port>`; SSL off; the GUI's "WebSocket Auth Key" field was left blank / "auto-generate". `lsof` confirms a separate `FTWebSocket` process listening on `127.0.0.1:33334`.

**What happened:**
- Pointed the spike at `33334` (its new default; `OPEND_PORT` override still honored) and ran `bun run src/futu/spike.ts`.
- The WebSocket handshake now **succeeds** — big change from Round 1. OpenD's `FTWebSocket_*.log` shows `Established` → `Recv, ProtoID:1` (our `InitConnect`) → `Closed`. So the transport works; OpenD received our init packet.
- OpenD then **rejects `InitConnect`**: the decoded `InitWebSocket.Response` is `{ retType: -1 }` with **no `s2c`** (so no `connID`) and no `retMsg`. The SDK surfaces this as a login failure (`onlogin(false)`); the spike prints `SPIKE FAILED: OpenD login failed`.
- `retType: -1` immediately after a clean handshake, with the auth-key field set to auto-generate, is the auth-key-required signature. OpenD generated a key at startup and enforces it on `InitConnect`.

**Where the auto-generated key lives (matters for the brother's setup docs):**
- It is **displayed only in the OpenD GUI** (the "WebSocket Auth Key" field in settings after auto-generation). Copy it from there.
- It is **NOT recoverable from disk.** Checked and came up empty: `OpenD.xml` (no `websocket_key_md5` element), the transient generated `WebSocket_<pid>.xml` (consumed and deleted at child-process spawn), all `~/.com.futunn.FutuOpenD/Log/*` (main `FutuOpenD_*.ftlog` is encrypted; the GTW log prints the WS port + "SSL Enabled: No" but not the key), the `F3CNN/*.dat` config blobs, the GUI plist (`cn.futu.FutuOpenDGUI.plist` is empty), and the macOS keychain. GUI UI-scripting to read the field is blocked (Accessibility permission not granted — not something this spike should change).
- **Setup-doc takeaway:** for a reproducible install, either (a) tell the user to **type a known key** into OpenD's WebSocket Auth Key field (don't auto-generate) and record it in the app config, or (b) **leave the key blank entirely** — TBD whether OpenD permits a truly keyless WebSocket; the auto-generate path definitely enforces one.

**How to pass the key (already wired in the spike):**
```bash
OPEND_WS_KEY='<key-from-OpenD-GUI>' OPEND_PORT=33334 bun run src/futu/spike.ts
```
The spike reads `OPEND_WS_KEY` and passes it as the 4th arg to `ftWebsocket.start(ip, port, /*ssl*/ false, key)`. The SDK MD5-hashes the plaintext key internally before sending, so pass the **plaintext** key exactly as shown in the GUI (do not pre-hash it).

**Still pending (blocked on the key):** the authenticated `bun run` (GetAccList + GetHistoryOrderFillList), and then the **critical `bun build --compile` check**. Both are one step away — provide the key and re-run.

**Confidence:** the connection path is proven end-to-end up to auth; this is a single-value credential gap, not a stack/runtime problem. GO remains likely once the key is supplied.
```
