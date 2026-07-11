import { test, expect } from "bun:test";
import { openTestDb } from "../helpers";
import { getDrawings, upsertDrawings, type Drawing } from "../../src/store/drawings";

test("getDrawings returns [] when no row exists for the trade", () => {
  const db = openTestDb();
  expect(getDrawings(db, "t1")).toEqual([]);
});

test("upsertDrawings + getDrawings round-trips", () => {
  const db = openTestDb();
  const drawings: Drawing[] = [
    { name: "trendline", points: [{ timestamp: 1000, value: 10 }, { timestamp: 2000, value: 12 }] },
    { name: "box", points: [{ timestamp: 1000, value: 8 }], extendData: { color: "#fff" } },
  ];
  upsertDrawings(db, "t1", drawings, 500);
  expect(getDrawings(db, "t1")).toEqual(drawings);
});

test("upsertDrawings replaces the prior set (not append) and is idempotent", () => {
  const db = openTestDb();
  upsertDrawings(db, "t1", [{ name: "a", points: [] }], 1);
  upsertDrawings(db, "t1", [{ name: "b", points: [] }], 2);
  const got = getDrawings(db, "t1");
  expect(got).toHaveLength(1);
  expect(got[0]!.name).toBe("b");
});

test("malformed stored JSON in the data column returns [] instead of throwing", () => {
  const db = openTestDb();
  db.run(
    `INSERT INTO chart_drawings (trade_id, data, updated_at) VALUES (?, ?, ?)`,
    ["t1", "{not json", 1],
  );
  expect(getDrawings(db, "t1")).toEqual([]);
});

test("drawings for one trade do not affect another trade's row", () => {
  const db = openTestDb();
  upsertDrawings(db, "t1", [{ name: "a", points: [] }], 1);
  expect(getDrawings(db, "t2")).toEqual([]);
});
