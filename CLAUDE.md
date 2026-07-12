# Trade Review — working agreement

Local-first desktop tool for reviewing your own FUTU trading. It syncs fills / orders / funds from a
local OpenD gateway into SQLite, reconstructs **trades** from raw fills, and scores each one —
R-multiple, risk, MAE/MFE, position size as % of account, and behavioural **flags**
(added-to-loser, cut-winner-early, wide-stop, improper-pyramid, …) — then shows it in a React SPA
with per-trade candle charts, open positions, and a journal. Single Bun binary: no server, no cloud,
no login — it binds `127.0.0.1` and opens a browser. Two independent users, each with their own
OpenD + FUTU account + local DB (no multi-tenancy). v1 has **no AI** (architected so MCP can be
added later).

## Run it locally

```bash
bun run src/app.ts        # backup + migrate DB → serve http://127.0.0.1:8123 → open browser
```

- Needs a `.env` (gitignored; copy `.env.example`) with `OPEND_WS_KEY`. **Syncing** also needs the
  OpenD gateway app running on `OPEND_PORT` (default 33334); without it the UI loads but Sync fails.
- The **frontend hot-reloads** (Bun HMR over the `web/` bundle). The **backend does NOT** — after
  editing `src/api/*` or `src/sync/*`, restart the process or you'll debug stale code.
- `NO_OPEN=1` skips the browser; `PORT=…` overrides 8123.

## Golden rules

- **Correctness of money math is non-negotiable.** Never sum P&L across currencies.
  Segment every aggregate by currency.
- **Keep it simple.** Don't overcomplicate. YAGNI.
- **Don't ask for permission on routine work.** Just do it, keep each PR clean, and
  report what happened.

## Branch & PR workflow

- Default branch is **`main`** (never `master`).
- **Every checkpoint ships as a PR.** Feature branch → PR → review → merge. Never
  commit straight to `main`.
- A PR is mergeable only when **all four gates are green**:
  1. `bun test` — all tests pass
  2. `bunx tsc --noEmit` — no type errors
  3. **Codex review is clean** (no must-fix findings) — see below
  4. Fable review is clean (adversarial second opinion, via the Agent tool `model: 'fable'`)
- Once the gates are green, **merge it yourself — don't ask.** Use
  `gh pr merge <n> --merge --delete-branch`, then sync local `main`.

## Reviewing a PR with Codex

Codex (`gpt-5.5`) is the primary automated reviewer. It runs non-interactively:

```bash
# review the current branch's changes against main
codex exec review --base main

# or review only uncommitted work in progress
codex exec review --uncommitted
```

Read every finding. Fix the real ones, push, and re-run until the review is clean.
Codex reads this file and `AGENTS.md` for project conventions, so keep them accurate.

## Tooling

- `bun` for everything JS/TS (runtime, `bun test`, `bun build --compile`, `bun:sqlite`).
- TypeScript strict, `noUncheckedIndexedAccess` on.
- Tools are managed via `mise`; shims are on PATH (no `mise exec` needed).

## Architecture

Data flows one way: **OpenD → sync → SQLite → pure core → JSON API → React SPA.**

**Backend (`src/`)**
- `domain/types.ts` — shared vocabulary (RawFill, Trade, RawOrder, StopInfo, Flag, RuleConfig, …).
  The frontend imports these SAME types over the wire, so shapes can't drift.
- `core/*` — pure functions, no I/O, exhaustively fixture-tested. The scoring pipeline:
  `trade-builder → stop-inference → risk → mae-mfe → analytics → rule-engine`.
- `store/*` — SQLite via `bun:sqlite`: versioned migrations + pre-migration backup via `VACUUM INTO`.
- `sync/*` — pulls from OpenD, persists raw data, then re-derives trades + flags.
- `futu/*` — OpenD gateway client (WebSocket via `futu-api`).
- `api/*` — framework-free JSON handlers + read-model assemblers (`api/views.ts`); server-free so
  tests hit them against an in-memory DB.
- `app.ts` — single-binary bootstrap (backup → migrate → serve API + bundled SPA).

**Frontend (`web/`)** — React 19 SPA, bundled by Bun's fullstack HTML import (no Vite/webpack).
wouter (routing) · TanStack Query (data) · Lightweight Charts + klinecharts (candles).
`lib/api.ts` is the typed client, `screens/*` are pages, `components/*` the pieces.

Plans live in `docs/superpowers/plans/`; the design spec in `docs/superpowers/specs/`. `AGENTS.md`
mirrors the conventions Codex reads — keep it in step with this file.
