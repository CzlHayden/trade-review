# Trade chart rebuild on klinecharts — Implementation Plan (v2, post-Fable)

**Goal:** Replace the trade-detail candlestick chart with klinecharts — enough bars to review WHY an entry was taken and WHERE the initial stop sat (intraday resolution), clear marks for entry / each exit / planned stop / effective stop / TP, and built-in drawing tools whose annotations persist per trade. Dashboard equity curve stays on Lightweight Charts.

**Architecture:** klinecharts renders candles from `/api/trades/:id/candles`, which gains a resolution strategy (finest interval that Yahoo covers for the padded trade window, with a coarsen-on-empty fallback ladder). Drawings persist in an orphan-tolerant `chart_drawings` table via a small store module + API routes + query hooks, mirroring the journal pattern. Our own trade-marks and user drawings live in separate klinecharts overlay groups so persistence never touches the marks.

**Tech Stack:** **klinecharts pinned to `10.0.0`** (Apache-2.0; v10 shipped 2026-07-10 with a `setDataLoader` API — NOT v9's `applyNewData`). Existing Yahoo candle source + multi-interval candle cache, bun:sqlite, TanStack Query, React 19 (StrictMode).

---

## Verified klinecharts v10 API (from the 10.0.0 tarball typings)

- Data: `const chart = init(el)` → `chart.setStyles(styleObj)` → `chart.setSymbol({ticker, pricePrecision, volumePrecision})` → `chart.setPeriod({span, type})` → `chart.setDataLoader({ getBars: ({type, callback}) => callback(bars, false) })`. `KLineData` wants `timestamp` (ms) — our `Candle.time` is already ms (NO `/1000`, unlike Lightweight Charts). `resetData()` re-triggers the loader.
- Volume: `chart.createIndicator('VOL')`.
- Overlays (all built-in, no custom templates): `horizontalStraightLine`, `priceLine`, `segment`, `straightLine`, `rect`, `fibonacciLine`, `simpleAnnotation`, `simpleTag`, `text`, `brush`. `chart.createOverlay({name, points, lock, groupId, styles, onDrawEnd, onPressedMoveEnd, onRemoved})`. `Overlay` has `lock`, `groupId`, `visible`, `zLevel`. `getOverlays({groupId})` / `removeOverlay({groupId})` accept a filter.
- Lifecycle: `dispose(chart)` tears down (needed for StrictMode double-mount — `init` dedupes on the DOM element's `id` attr, which our div lacks, so rely on dispose in cleanup). There is **no** overlay event in `subscribeAction` — overlay save hooks are the per-overlay `onDrawEnd`/`onPressedMoveEnd`/`onRemoved` callbacks passed to `createOverlay`.

## Window & resolution policy — WIDE CONTEXT is the point

The goal is reviewing the setup, so the default must show generous history around the trade, not just the trade window. Daily is the workhorse (Yahoo daily is free, keyless, decades deep, no quota); intraday is an opt-in zoom for the entry moment (Yahoo intraday retention: 1h≈2yr, 15m≈60d, 1m≈7d).

`windowFor(openTime, closeTime, now, res)` returns `{ resMs, fromMs, toMs, focusFrom, focusTo }`:
- **`1d` (default):** `fromMs = openTime − ~1 year` (clamped to available history), `toMs = (closeTime ?? now) + ~5% pad`. ~250+ bars of context.
- **`1h` (zoom):** `fromMs = openTime − ~10 trading days`, `toMs = (closeTime ?? now) + ~2 days`, clamped to Yahoo's ~2yr 1h reach.
- **`15m` (fine zoom):** `fromMs = openTime − ~2 days`, `toMs = closeTime + ~1 day`, clamped to ~60d reach.
- `focusFrom/focusTo` = the trade window + moderate pad — the client's INITIAL visible range, so the chart opens focused on the trade but the full history is loaded to scroll back through.

Route behavior (`/api/trades/:id/candles?res=1d|1h|15m`, default `1d`):
1. Prefer the requested res whose **cache coverage already contains** the window; else fetch.
2. **If an intraday res returns empty** (window predates Yahoo's intraday reach), coarsen one step (15m→1h→1d) and retry so the chart is never blank.
3. Respond `{ res, resMs, focusFrom, focusTo, candles: Candle[] }` — client sets the klinecharts Period from `res` and the initial visible range from `focusFrom/focusTo`.

## Drawing persistence — explicit schema (do NOT serialize raw klinecharts overlays)

Store our own minimal shape, making format stability our contract:
`Drawing = { name: string; points: Array<{ timestamp?: number; value?: number }>; extendData?: unknown }` — **strip `dataIndex`** (price/time only, so drawings re-anchor correctly across a resolution flip). Validate every element on PUT. Restore each overlay in its own try/catch so one bad row can't poison the chart. Cap payload (≤200 overlays / ≤256 KB).

---

## Task 1: Window/resolution strategy + candles response shape

**Files:** Create `src/core/candle-res.ts` + `test/core/candle-res.test.ts`. Modify `src/api/routes.ts` (candles handler ~line 203), `web/lib/api.ts` (`candles`), `web/lib/hooks.ts` (`useCandles`), `web/screens/TradeDetail.tsx` (delete the `holdSeconds<2d?"hour":"day"` heuristic + `res` prop threading).

- [ ] `windowFor(openTime, closeTime, now, res)` pure fn per policy above. Tests: default `1d` → ~1yr before open; `1h` → ~10d before open, clamped to 2yr reach; `15m` → ~2d before open; open trade uses `now` for `toMs`; `focusFrom/focusTo` = trade window + pad.
- [ ] Candles route: default `res=1d`; cache-coverage-first; coarsen-on-empty ladder (15m→1h→1d); respond `{ res, resMs, focusFrom, focusTo, candles }`.
- [ ] Client: `api.candles(id, res="1d")` returns the object; `useCandles(id, res)` queryKey `["candles", id, res]`; delete the old heuristic. A `res` state in TradeChart drives the 1D/1H/15m toggle.

## Task 2: Drawings persistence — storage

**Files:** Modify `src/store/migrations.ts` (v7). Create `src/store/drawings.ts` + `test/store/drawings.test.ts`.

- [ ] Migration v7: `CREATE TABLE chart_drawings (trade_id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL)` — orphan-tolerant, no FK (trades is DELETEd every rebuild; trade ids are deterministic — journal precedent). Test: table exists; migrations reach v7.
- [ ] `getDrawings(db, tradeId): Drawing[]` (JSON-parsed, `[]` when absent) + `upsertDrawings(db, tradeId, drawings, now)`. Test: round-trip; empty when none; upsert replaces.

## Task 3: Drawings API + hooks

**Files:** Modify `src/api/routes.ts`, `web/lib/api.ts`, `web/lib/hooks.ts`, `test/api/routes.test.ts`.

- [ ] `GET /api/trades/:id/drawings` → `{ drawings: Drawing[] }`. `PUT` validates: array, ≤200 items, each `{name:string, points:Array<{timestamp?,value?}>}`, serialized ≤256 KB → else 400; upserts; NO rebuild. Test: PUT then GET; non-array/oversized/bad-element → 400.
- [ ] `api.drawings(id)` / `api.putDrawings(id, drawings)`; `useDrawings(id)` / `usePutDrawings(id)` invalidating `["drawings", id]`.

## Task 4: TradeChart rewrite on klinecharts (v10 API)

**Files:** `package.json` (`"klinecharts": "10.0.0"` — exact pin, self-updating binary must not drift on overlay internals). Rewrite `web/components/TradeChart.tsx`.

- [ ] `bun add klinecharts@10.0.0`.
- [ ] Mount: container div always rendered (with an `id`); `init(el)` in an effect; cleanup `dispose(chart)` (StrictMode-safe). `barsRef` holds current candles; `setDataLoader({getBars:({type,callback})=>callback(barsRef.current,false)})`.
- [ ] On `{res,candles,focusFrom,focusTo}` change: update `barsRef`, `setSymbol({ticker, pricePrecision})`, `setPeriod(resToPeriod(res))`, `resetData()`; set the initial visible range to `focusFrom..focusTo` (chart opens focused on the trade, full history loaded to scroll back). `createIndicator('VOL')` once.
- [ ] Resolution toggle (1D / 1H / 15m) driving the `res` state → refetch. Default 1D (wide context).
- [ ] Marks group (`groupId:'marks'`, `lock:true`), replace-not-accumulate (`removeOverlay({groupId:'marks'})` then recreate): entry `priceLine`/annotation at avg; each exit fill as `simpleAnnotation` at its time+price; **planned stop** = `journal.manualStop ?? stop.initialStop` labeled `manual stop` or `planned stop`; effective stop; TP — all theme-colored. When `trade.risk === null` but a stop exists (seed/profit-side), render the planned-stop line dashed + "unverified" (never contradict the R beside it).
- [ ] Theme: `setStyles(themeStyles(themeKey))`; recreate the marks group on `themeKey` change (explicit colors don't inherit `setStyles`).

## Task 5: Drawing tools + persistence wiring

**Files:** `web/components/TradeChart.tsx`, `web/screens/TradeDetail.tsx`.

- [ ] Toolbar: horizontalStraightLine, segment, rect, fibonacciLine, brush, erase → `chart.createOverlay({name, groupId:'user', onDrawEnd, onPressedMoveEnd, onRemoved})`.
- [ ] On those callbacks, serialize the `'user'` group to our `Drawing[]` (timestamp+value only, strip dataIndex), debounced ~500ms `usePutDrawings`; **flush on unmount** (last edit before navigating must not be lost). Guard a `hydrating` ref so the load→recreate path can't trigger a save.
- [ ] On mount / trade change: `useDrawings`, `removeOverlay({groupId:'user'})`, recreate each saved drawing in its own try/catch.

## Task 6: Verify + ship

- [ ] Localhost: ALAB opens focused on the trade but scrolls back to ~1yr of daily context, entry/exits/planned-SL/effective-SL/TP marked; 1H/15m toggle zooms to the entry moment; draw a line, navigate away + back, it persists; light/dark clean; CRWD (seed) renders candles fine, planned-stop line dashed/omitted (risk null), off-scale split marks stay off-screen (verify no y-axis blowout).
- [ ] `bun test` + `bunx tsc --noEmit` green.
- [ ] Fable + Codex review, then PR.
