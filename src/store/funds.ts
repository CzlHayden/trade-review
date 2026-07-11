import type { Database } from "bun:sqlite";
import type { AccountFunds } from "../domain/types";

/** Persist an equity snapshot. PK (account, time, currency) makes re-inserts within one sync idempotent. */
export function insertFunds(db: Database, f: AccountFunds): void {
  db.run(
    `INSERT INTO account_funds (account, time, currency, total_assets, cash, market_val)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(account, time, currency) DO UPDATE SET
       total_assets = excluded.total_assets,
       cash = excluded.cash,
       market_val = excluded.market_val`,
    [f.account, f.time, f.currency, f.totalAssets, f.cash, f.marketVal],
  );
}

/** Net account equity in `currency` as of `atMs` — the latest snapshot at or before that time.
 * Same-currency only (never mix denominations). Null when no snapshot precedes the time (e.g. a
 * trade opened before this feature started capturing funds; OpenD has no historical funds query). */
export function equityAsOf(
  db: Database,
  account: string,
  currency: string,
  atMs: number,
): number | null {
  const row = db
    .query(
      `SELECT total_assets FROM account_funds
       WHERE account = ? AND currency = ? AND time <= ?
       ORDER BY time DESC LIMIT 1`,
    )
    .get(account, currency, atMs) as { total_assets: number } | null;
  return row?.total_assets ?? null;
}

/** The latest equity snapshot per currency for an account (used for portfolio-level open-risk %). */
export function latestEquityByCurrency(db: Database, account: string): Map<string, number> {
  const rows = db
    .query(
      `SELECT currency, total_assets FROM account_funds f
       WHERE time = (SELECT MAX(time) FROM account_funds WHERE account = f.account AND currency = f.currency)
         AND account = ?`,
    )
    .all(account) as Array<{ currency: string; total_assets: number }>;
  return new Map(rows.map((r) => [r.currency, r.total_assets]));
}
