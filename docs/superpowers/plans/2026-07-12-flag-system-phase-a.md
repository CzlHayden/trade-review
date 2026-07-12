# Flag system — Phase A

Redesign the mistake-flag engine into a small *system*: a flag-definition registry that
powers tooltips + grouping + analytics, a corrected `held_past_stop`, and the field-only
"Phase A" behaviour flags. Later phases add OHLCV/equity flags and flag→performance analytics.

## Motivation

`held_past_stop` fired on a clean −1.00R stop-out (US.NBIS): MAE (a candle **wick**, 9.641/sh)
poked $0.24 past the 207.54 stop, so `mae > |entry−stop|` tripped even though the trader exited
*at* the stop for exactly −1R. Two root causes:

1. **Semantic** — the rule keyed off a wick (excursion), not off *behaviour/outcome* (did you
   honour the stop). A −1R exit at the stop is disciplined, the opposite of "held past".
2. **Resolution smear** — a 2h14m trade measured MAE on **1h** candles; the exit-bar low may
   have printed *after* the exit. (Deferred: the smear fix ships with `stop_wicked`, see below.)

## Three design principles (what makes it a system)

- **Kind: behaviour / outcome / context / hygiene.** Changes wording + how much it's a "mistake".
  A gap through a correct stop is an *outcome*, not a sin.
- **Every threshold has a noise band** expressed in R or %, never raw price/EPS. No flag fires on
  a 0.1% wick.
- **Data tiers gate rollout:** [F] trade fields → [C] OHLCV → [$] equity → [J] journal → [X]
  cross-trade → [I] index (not ingested).

## The registry (foundational)

`src/domain/flag-defs.ts` — one source of truth, keyed by ruleId, imported by engine **and** web:

```ts
type FlagCategory = "stop-risk" | "sizing" | "entry" | "exit" | "timing" | "hygiene";
type FlagKind = "behavior" | "outcome" | "context" | "hygiene";
interface FlagDef {
  id: string; title: string; category: FlagCategory; kind: FlagKind;
  defaultSeverity: "info" | "warn";
  summary: string; // "what it means" (tooltip)
  why: string;     // "why it matters" (tooltip)
}
```

Per-trade `Flag` keeps `{ruleId, severity, reason}` — `reason` is the *dynamic* instance.
Tooltip = `title` + `summary` + `why` (registry) + `reason` (this trade).

## Phase A flags (this PR)

Replace `held_past_stop` and add field-tier rules. `[F]` unless noted.

| id | kind | sev | fires when |
|---|---|---|---|
| `excess_loss` | outcome | warn | `rMultiple < −excessLossR` (default 1.3R) — loss deeper than plan (gaps/slippage/unhonoured stop) |
| `no_stop` | behavior | warn | `trade.risk === null` — no loss-limiting stop basis |
| `wide_stop` | behavior | warn | `(risk/maxQty)/entry > maxStopPct` (default 8%) |
| `improper_pyramid` | behavior | info | an add is larger than the first tranche, or added `> pyramidExtendedPct` above first entry |
| `overtrading_freq` | behavior | info | `> overtradeMaxOpens` opens within `overtradeWindowDays` |

`held_past_stop` (old MAE-warn rule) is **removed**. `stop_wicked` (the info-level wick flag) and
the MAE-resolution fix are **deferred** to their own PR — reintroduce the wick signal only once MAE
is trustworthy. `no_r_computable` is dropped: in our model `risk===null ⇔ no loss-side stop`, so
`no_stop` already covers it.

`no_stop`/`wide_stop` read `trade.risk` (= `|entry−stop|×size`, and `null` for profit-side or
split-corrupted stops per `risk.ts`) so they inherit that guard and never false-fire on a
profit-protecting stop — a review finding on an earlier draft that keyed off raw stop distance.

**`loosened_stop` is deferred** (was in the first draft, pulled after review). The data can't support
it correctly yet: FUTU `raw_orders` is upserted by order id, so an in-place ModifyOrder overwrites the
prior trigger (the common loosening is invisible), while cancel-and-replace plus multi-tier scale-out
stops produce spurious "loosened" warns. It needs persisted per-modification order history + tier
handling — a later PR. Shipping it would reintroduce exactly the false-warn-on-good-behaviour this
branch exists to remove.

## Plumbing

- `RuleContext` gains optional `recentOpens?: number[]` — open times of prior coverage-ok trades, so
  `overtrading_freq` counts opens by time (held positions included), not just trades that closed
  before this one opened. Optional → existing tests still compile.
- `src/core/stop-inference.ts` factors a private `protectiveStops()` helper (no new public surface).
- `RuleConfig` + `DEFAULT_RULE_CONFIG` gain: `excessLossR` (1.3), `maxStopPct` (0.08),
  `pyramidExtendedPct` (0.05), `overtradeWindowDays` (1), `overtradeMaxOpens` (3). Shallow-merge in
  `config.ts` already back-fills these for old stored configs.

## UI (this PR)

- `FlagChips`: registry `title`, severity class (have it), hover tooltip = summary + why + reason.
- `TradeDetail` Flags section: group chips by `category`.
- `humanizeRule` → registry title with humanize fallback for unknown ids.
- Web imports `flag-defs.ts` directly (Bun fullstack already imports `src/domain/*`).

## Deferred (later PRs)

Phase-B [C]/[$] flags (`entry_against_trend`, `extended_entry`, `low_volume_breakout`,
`chased_gap`, `risk_over_cap`, `over_concentrated`, `sized_up_cold`, `no_breakeven`,
`low_exit_efficiency`, `no_scale_out`) · `loosened_stop` (needs persisted order-modification history
+ tier handling) · `stop_wicked` + MAE-resolution fix · flag→performance &
clean-baseline analytics + drill-down · dismiss/settings UI · `portfolio_heat`, `market_downtrend`
(index ingest), `ignored_sell_signal`, `laggard_entry`, `conviction_mismatch`. Cut: `poor_entry_fill`,
`sold_into_weakness` (daily-bar intraday-location guesswork — the smear class of bug).

## Gates

`bun test` · `bunx tsc --noEmit` · Codex review clean · Fable review clean. Then self-merge.
