import { test, expect } from "bun:test";
import { openTestDb } from "../helpers";
import { getStoredOpend, setStoredOpend, opendConnection, setConfigValue, DEFAULT_OPEND_PORT } from "../../src/store/config";

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

test("opendConnection: stored key/port, with default port when unset", () => {
  expect(opendConnection({ key: "stored-key", port: 40000 })).toEqual({ key: "stored-key", port: 40000 });
  // no key stored → undefined; no port stored → default
  expect(opendConnection({ key: null, port: null })).toEqual({ key: undefined, port: DEFAULT_OPEND_PORT });
  // port set, key unset
  expect(opendConnection({ key: null, port: 41000 })).toEqual({ key: undefined, port: 41000 });
});
