import type { Database } from "bun:sqlite";

/** Our own minimal chart-drawing shape — NOT raw chart-library internals. This is our contract;
 * the chart component that produces/consumes these adapts to/from whatever library it uses. */
export interface Drawing {
  name: string;
  points: Array<{ timestamp?: number; value?: number }>;
  extendData?: unknown;
}

/** Drawings saved for a trade, or `[]` when none exist yet or the stored JSON is malformed. */
export function getDrawings(db: Database, tradeId: string): Drawing[] {
  const row = db.query(`SELECT data FROM chart_drawings WHERE trade_id = ?`).get(tradeId) as
    | { data: string }
    | null;
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.data);
    return Array.isArray(parsed) ? (parsed as Drawing[]) : [];
  } catch {
    return [];
  }
}

/** Upsert (replace, not append) the full drawing set for a trade. */
export function upsertDrawings(db: Database, tradeId: string, drawings: Drawing[], now: number): void {
  db.run(
    `INSERT INTO chart_drawings (trade_id, data, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(trade_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
    [tradeId, JSON.stringify(drawings), now],
  );
}
