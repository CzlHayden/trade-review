import { test, expect } from "bun:test";
import { serveStatic } from "../../src/api/static";

test("serves index.html at / and falls back to it for unknown non-/api paths (SPA history)", async () => {
  const root = await serveStatic(new Request("http://x/"));
  expect(root).not.toBeNull();
  expect(await root!.text()).toContain("Trade Review");
  const deep = await serveStatic(new Request("http://x/trades/123")); // client route
  expect(deep!.status).toBe(200);
  expect(await deep!.text()).toContain("Trade Review");
});

test("returns null for /api paths so the API handler takes them", async () => {
  expect(await serveStatic(new Request("http://x/api/stats"))).toBeNull();
});
