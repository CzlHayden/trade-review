import { test, expect } from "bun:test";
import { DEFAULT_OPEND_PORT as WEB_DEFAULT } from "../../web/lib/constants";
import { DEFAULT_OPEND_PORT as STORE_DEFAULT } from "../../src/store/config";

// The web bundle can't import from src/store (bun:sqlite), so DEFAULT_OPEND_PORT is duplicated.
// This guard fails if the two ever drift.
test("web and store agree on DEFAULT_OPEND_PORT", () => {
  expect(WEB_DEFAULT).toBe(STORE_DEFAULT);
});
