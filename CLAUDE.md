# Trade Review — working agreement

Local-first FUTU trade-review tool. Bun + TypeScript, single binary. Two independent
users (each runs their own OpenD gateway + FUTU account + local SQLite DB — no multi-tenancy).
v1 has **no AI** (architected so MCP can be added later).

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

## Architecture (pure core, all fixture-tested)

```
trade-builder → stop-inference → risk → mae-mfe → analytics → rule-engine
```

- `src/domain/types.ts` — shared vocabulary (RawFill, Trade, RawOrder, StopInfo, Flag, …).
- `src/core/*` — pure functions, no I/O, exhaustively unit-tested.
- `src/store/*` — SQLite: versioned migrations + pre-migration backup via `VACUUM INTO`.
- `src/futu/*` — OpenD gateway client (WebSocket via `futu-api`).

Plans live in `docs/superpowers/plans/`; the design spec in `docs/superpowers/specs/`.
