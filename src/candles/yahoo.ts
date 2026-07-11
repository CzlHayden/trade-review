// Single free candle source: Yahoo Finance chart API. No API key. Covers US + HK in v1.
// The fetch is injectable so the parser + URL-building are unit-tested offline; a network/parse
// failure degrades to [] so a sync never breaks on missing candles (spec §12).

import type { Candle } from "../domain/types";
import type { CandleSource } from "../domain/ports";

/** Domain symbol (`"<MKT>.<code>"`) → Yahoo symbol. US + HK only in v1. */
export function yahooSymbol(symbol: string): string {
  const dot = symbol.indexOf(".");
  const market = symbol.slice(0, dot);
  const code = symbol.slice(dot + 1); // split on the FIRST dot only — code may contain dots (BRK.B)
  if (market === "US") return code.replace(/\./g, "-"); // Yahoo class shares: BRK.B → BRK-B
  if (market === "HK") {
    // FUTU HK codes are 5 digits ("00700"); Yahoo wants 4 ("0700.HK").
    return `${code.replace(/^0(\d{4})$/, "$1")}.HK`;
  }
  throw new Error(`Unsupported market for candles: ${symbol}`);
}

export function intervalFor(resMs: number): string {
  const DAY = 86_400_000;
  if (resMs >= 90 * DAY) return "3mo"; // quarterly
  if (resMs >= 28 * DAY) return "1mo"; // monthly
  if (resMs >= 7 * DAY) return "1wk"; // weekly
  if (resMs >= DAY) return "1d";
  if (resMs >= 3_600_000) return "1h";
  if (resMs >= 900_000) return "15m";
  return "1m";
}

type FetchLike = (url: string) => Promise<{ ok: boolean; status?: number; json: () => Promise<any> }>;

/** Parse a Yahoo chart response into candles, skipping null-quote gaps. */
export function parseChart(json: any): Candle[] {
  const result = json?.chart?.result?.[0];
  const ts: number[] | undefined = result?.timestamp;
  const q = result?.indicators?.quote?.[0];
  if (!ts || !q) return [];
  const out: Candle[] = [];
  for (let i = 0; i < ts.length; i++) {
    const open = q.open?.[i];
    const high = q.high?.[i];
    const low = q.low?.[i];
    const close = q.close?.[i];
    const volume = q.volume?.[i];
    if (open == null || high == null || low == null || close == null) continue; // gap
    out.push({ time: ts[i]! * 1000, open, high, low, close, volume: volume ?? 0 });
  }
  return out;
}

export async function getCandles(
  symbol: string,
  fromMs: number,
  toMs: number,
  resMs: number,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<Candle[]> {
  let sym: string;
  try {
    sym = yahooSymbol(symbol);
  } catch {
    return []; // unsupported market → no candles, but never throw into sync
  }
  const p1 = Math.floor(fromMs / 1000);
  const p2 = Math.floor(toMs / 1000);
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${sym}` +
    `?period1=${p1}&period2=${p2}&interval=${intervalFor(resMs)}`;
  try {
    const res = await fetchImpl(url);
    if (!res.ok) return [];
    return parseChart(await res.json());
  } catch {
    return [];
  }
}

/** The live CandleSource used by the sync CLI. */
export const yahooCandles: CandleSource = {
  getCandles: (symbol, fromMs, toMs, resMs) => getCandles(symbol, fromMs, toMs, resMs),
};
