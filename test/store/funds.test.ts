import { test, expect } from "bun:test";
import { openTestDb } from "../helpers";
import { insertFunds, equityAsOf, latestEquityByCurrency } from "../../src/store/funds";
import type { AccountFunds } from "../../src/domain/types";

function funds(over: Partial<AccountFunds>): AccountFunds {
  return {
    account: "acc1",
    currency: "USD",
    totalAssets: 10_000,
    cash: 5_000,
    marketVal: 5_000,
    time: 1000,
    ...over,
  };
}

test("equityAsOf returns the latest snapshot at or before the time; null before any", () => {
  const db = openTestDb();
  insertFunds(db, funds({ time: 1000, totalAssets: 10_000 }));
  insertFunds(db, funds({ time: 2000, totalAssets: 12_000 }));
  expect(equityAsOf(db, "acc1", "USD", 500)).toBeNull(); // before first snapshot → no backfill
  expect(equityAsOf(db, "acc1", "USD", 1000)).toBe(10_000);
  expect(equityAsOf(db, "acc1", "USD", 1500)).toBe(10_000); // most recent ≤ 1500
  expect(equityAsOf(db, "acc1", "USD", 9000)).toBe(12_000);
});

test("equityAsOf never mixes currencies", () => {
  const db = openTestDb();
  insertFunds(db, funds({ currency: "USD", totalAssets: 10_000 }));
  insertFunds(db, funds({ currency: "HKD", totalAssets: 80_000 }));
  expect(equityAsOf(db, "acc1", "USD", 9000)).toBe(10_000);
  expect(equityAsOf(db, "acc1", "HKD", 9000)).toBe(80_000);
  expect(equityAsOf(db, "acc1", "SGD", 9000)).toBeNull();
});

test("insertFunds is idempotent on (account, time, currency)", () => {
  const db = openTestDb();
  insertFunds(db, funds({ time: 1000, totalAssets: 10_000 }));
  insertFunds(db, funds({ time: 1000, totalAssets: 11_000 })); // same key → upsert
  expect(equityAsOf(db, "acc1", "USD", 1000)).toBe(11_000);
});

test("latestEquityByCurrency returns one latest value per currency", () => {
  const db = openTestDb();
  insertFunds(db, funds({ currency: "USD", time: 1000, totalAssets: 10_000 }));
  insertFunds(db, funds({ currency: "USD", time: 2000, totalAssets: 12_000 }));
  insertFunds(db, funds({ currency: "HKD", time: 1500, totalAssets: 80_000 }));
  const m = latestEquityByCurrency(db, "acc1");
  expect(m.get("USD")).toBe(12_000);
  expect(m.get("HKD")).toBe(80_000);
  expect(m.size).toBe(2);
});
