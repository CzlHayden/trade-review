import { test, expect } from "bun:test";
import { openTestDb } from "../helpers";
import { getStoredOpend, setStoredOpend, resolveOpend, setConfigValue, DEFAULT_OPEND_PORT } from "../../src/store/config";

test("getStoredOpend returns nulls when nothing is stored", () => {
  const db = openTestDb();
  expect(getStoredOpend(db)).toEqual({ key: null, port: null });
});

test("setStoredOpend persists key + port and reads back", () => {
  const db = openTestDb();
  setStoredOpend(db, { key: "abc123", port: 33334 });
  expect(getStoredOpend(db)).toEqual({ key: "abc123", port: 33334 });
});

test("setStoredOpend merges a partial patch (port-only leaves the saved key intact)", () => {
  const db = openTestDb();
  setStoredOpend(db, { key: "abc123", port: 11111 });
  setStoredOpend(db, { port: 22222 });
  expect(getStoredOpend(db)).toEqual({ key: "abc123", port: 22222 });
});

test("getStoredOpend degrades to nulls on a malformed row, and PUT can repair it", () => {
  const db = openTestDb();
  // Simulate a corrupt / legacy value written directly into the config table.
  setConfigValue(db, "opend", "{not valid json");
  expect(getStoredOpend(db)).toEqual({ key: null, port: null }); // no throw
  // The repair path still works (setStoredOpend reads via getStoredOpend first).
  setStoredOpend(db, { key: "fixed", port: 33334 });
  expect(getStoredOpend(db)).toEqual({ key: "fixed", port: 33334 });
});

test("getStoredOpend tolerates a literal null / non-object row", () => {
  const db = openTestDb();
  setConfigValue(db, "opend", "null");
  expect(getStoredOpend(db)).toEqual({ key: null, port: null });
});

test("resolveOpend: env overrides stored, else stored, else default port / no key", () => {
  const stored = { key: "stored-key", port: 40000 };
  // env wins over stored
  expect(resolveOpend(stored, { key: "env-key", port: "50000" })).toEqual({ key: "env-key", port: 50000 });
  // stored used when env is absent
  expect(resolveOpend(stored, {})).toEqual({ key: "stored-key", port: 40000 });
  // neither → default port, no key
  expect(resolveOpend({ key: null, port: null }, {})).toEqual({ key: undefined, port: DEFAULT_OPEND_PORT });
  // empty-string env is treated as absent (not an override)
  expect(resolveOpend(stored, { key: "", port: "" })).toEqual({ key: "stored-key", port: 40000 });
  // a non-numeric env port is ignored (falls back to stored)
  expect(resolveOpend(stored, { port: "not-a-number" })).toEqual({ key: "stored-key", port: 40000 });
});
