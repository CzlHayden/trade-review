/** Per-trade journal. All fields optional except the linkage + timestamp. */
export interface Journal {
  tradeId: string;
  thesis: string | null;
  emotion: string | null;
  conviction: number | null; // 1..5
  rating: number | null; // 1..5
  notes: string | null; // markdown
  manualStop: number | null; // authoritative over inferred stop (see Plan 6 decision 3)
  setup: string | null; // single-select, drives "by setup" analytics
  tags: string[]; // freeform multi
  updatedAt: number;
}

/** Optional weekly journal entry + its watchlist. Trades are associated by date, never stored. */
export interface WeeklyEntry {
  id: string; // ISO week key "YYYY-Www"
  periodStart: number; // epoch ms inclusive
  periodEnd: number; // epoch ms exclusive
  marketRead: string | null;
  tradedVsPlan: string | null;
  watchlist: WatchlistItem[];
  updatedAt: number;
}

export interface WatchlistItem {
  symbol: string;
  note: string | null;
  keyLevel: number | null;
}
