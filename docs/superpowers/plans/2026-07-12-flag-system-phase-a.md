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
| `loosened_stop` | behavior | warn | a later protective-stop trigger is more adverse than an earlier one (`stopTimeline`) |
| `no_stop` | behavior | warn | no protective stop / risk basis (`initialStop === null`) |
| `wide_stop` | behavior | warn | `|entry−initialStop|/entry > maxStopPct` (default 8%) |
| `improper_pyramid` | behavior | info | an add is larger than the first tranche, or added `> pyramidExtendedPct` above first entry |
| `overtrading_freq` | behavior | info | `> overtradeMaxOpens` opens within `overtradeWindowDays` |

`held_past_stop` (old MAE-warn rule) is **removed**. `stop_wicked` (the info-level wick flag) and
the MAE-resolution fix are **deferred** to their own PR — reintroduce the wick signal only once MAE
is trustworthy. `no_r_computable` is dropped: in our model `risk===null ⇔ no stop`, so `no_stop`
already covers it.

## Plumbing

- `RuleContext` gains optional `initialStop?: number|null` and `stopTimeline?: number[]`
  (chronological protective-stop triggers). Optional → existing tests still compile.
- `src/core/stop-inference.ts` exposes a helper returning the chronological protective-stop
  trigger sequence; `sync.ts` feeds it (and the already-computed `initialStop`) into `RuleContext`.
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
`low_exit_efficiency`, `no_scale_out`) · `stop_wicked` + MAE-resolution fix · flag→performance &
clean-baseline analytics + drill-down · dismiss/settings UI · `portfolio_heat`, `market_downtrend`
(index ingest), `ignored_sell_signal`, `laggard_entry`, `conviction_mismatch`. Cut: `poor_entry_fill`,
`sold_into_weakness` (daily-bar intraday-location guesswork — the smear class of bug).

## Gates

`bun test` · `bunx tsc --noEmit` · Codex review clean · Fable review clean. Then self-merge.
