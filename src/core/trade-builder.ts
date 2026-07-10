import type { Direction, RawFill, SeedPosition, Trade } from "../domain/types";

interface Acc {
  account: string;
  symbol: string;
  currency: string;
  direction: Direction;
  openTime: number;
  entryQty: number;
  entryValue: number;
  exitQty: number;
  exitValue: number;
  fees: number;
  maxQty: number;
  position: number; // signed
  fillIds: string[];
  lastTime: number;
  coverageOk: boolean;
}

function sign(n: number): number {
  return n === 0 ? 0 : n > 0 ? 1 : -1;
}

function groupKey(f: { account: string; symbol: string }): string {
  return `${f.account}|${f.symbol}`;
}

function newAcc(f: RawFill, direction: Direction, coverageOk: boolean): Acc {
  return {
    account: f.account,
    symbol: f.symbol,
    currency: f.currency,
    direction,
    openTime: f.time,
    entryQty: 0,
    entryValue: 0,
    exitQty: 0,
    exitValue: 0,
    fees: 0,
    maxQty: 0,
    position: 0,
    fillIds: [],
    lastTime: f.time,
    coverageOk,
  };
}

/** Apply a quantity portion of a fill as an entry (increasing exposure). */
function applyEntry(acc: Acc, f: RawFill, qty: number): void {
  acc.entryQty += qty;
  acc.entryValue += qty * f.price;
  acc.fees += f.fee * (qty / f.qty);
  acc.position += acc.direction === "LONG" ? qty : -qty;
  acc.maxQty = Math.max(acc.maxQty, Math.abs(acc.position));
  acc.lastTime = f.time;
  if (!acc.fillIds.includes(f.id)) acc.fillIds.push(f.id);
}

/** Apply a quantity portion of a fill as an exit (reducing exposure). */
function applyExit(acc: Acc, f: RawFill, qty: number): void {
  acc.exitQty += qty;
  acc.exitValue += qty * f.price;
  acc.fees += f.fee * (qty / f.qty);
  acc.position += acc.direction === "LONG" ? -qty : qty;
  acc.lastTime = f.time;
  if (!acc.fillIds.includes(f.id)) acc.fillIds.push(f.id);
}

function finalize(acc: Acc): Trade {
  const closed = acc.position === 0;
  const avgEntry = acc.entryQty > 0 ? acc.entryValue / acc.entryQty : 0;
  const avgExit = acc.exitQty > 0 ? acc.exitValue / acc.exitQty : null;
  let realizedPnl: number | null = null;
  if (closed) {
    realizedPnl =
      acc.direction === "LONG"
        ? acc.exitValue - acc.entryValue - acc.fees
        : acc.entryValue - acc.exitValue - acc.fees;
  }
  return {
    id: `${acc.account}:${acc.symbol}:${acc.openTime}`,
    account: acc.account,
    symbol: acc.symbol,
    currency: acc.currency,
    direction: acc.direction,
    status: closed ? "closed" : "open",
    openTime: acc.openTime,
    closeTime: closed ? acc.lastTime : null,
    avgEntry,
    avgExit,
    maxQty: acc.maxQty,
    realizedPnl,
    fees: acc.fees,
    holdSeconds: closed ? Math.round((acc.lastTime - acc.openTime) / 1000) : null,
    coverageOk: acc.coverageOk,
    fillIds: acc.fillIds,
  };
}

export function buildTrades(fills: RawFill[], seeds: SeedPosition[] = []): Trade[] {
  const seedMap = new Map<string, number>();
  for (const s of seeds) seedMap.set(groupKey(s), s.qty);

  const groups = new Map<string, RawFill[]>();
  for (const f of fills) {
    const k = groupKey(f);
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(f);
  }

  const trades: Trade[] = [];

  for (const [key, groupFills] of groups) {
    groupFills.sort((a, b) => a.time - b.time);
    const seedQty = seedMap.get(key) ?? 0;

    let position = 0;
    let acc: Acc | null = null;

    // Seed a pre-existing position: open an accumulator whose entry is unknown.
    if (seedQty !== 0) {
      const first = groupFills[0]!;
      acc = newAcc(first, seedQty > 0 ? "LONG" : "SHORT", false);
      acc.entryQty = Math.abs(seedQty);
      acc.position = seedQty;
      acc.maxQty = Math.abs(seedQty);
      acc.openTime = first.time; // best available; coverageOk=false marks it approximate
      position = seedQty;
    }

    for (const f of groupFills) {
      const signed = f.side === "BUY" ? f.qty : -f.qty;

      if (position === 0) {
        acc = newAcc(f, signed > 0 ? "LONG" : "SHORT", true);
        applyEntry(acc, f, f.qty);
        position = acc.position;
        continue;
      }

      if (sign(signed) === sign(position)) {
        applyEntry(acc!, f, f.qty); // adding in the same direction
        position = acc!.position;
        continue;
      }

      // reducing
      if (Math.abs(signed) <= Math.abs(position)) {
        applyExit(acc!, f, f.qty);
        position = acc!.position;
        if (position === 0) {
          trades.push(finalize(acc!));
          acc = null;
        }
      } else {
        // flip through zero: close current with the closing portion, open new with the rest
        const closingQty = Math.abs(position);
        const remaining = Math.abs(signed) - closingQty;
        applyExit(acc!, f, closingQty);
        trades.push(finalize(acc!));
        acc = newAcc(f, signed > 0 ? "LONG" : "SHORT", true);
        applyEntry(acc, f, remaining);
        position = acc.position;
      }
    }

    if (acc && position !== 0) trades.push(finalize(acc)); // leftover open trade
  }

  return trades;
}
