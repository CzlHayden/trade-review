// SPA static serving. Returns null for /api/* (the JSON API owns those). Everything else GETs the
// SPA shell — index.html for "/" AND any client route (history-mode fallback). Plan 7 adds built
// assets; the `with { type: "file" }` import is the pattern that survives `bun build --compile`.
// `with { type: "file" }` resolves to the file PATH at runtime (and embeds it under --compile);
// Bun's TS types infer HTMLBundle from the .html extension, so cast to the string path Bun.file wants.
import indexHtml from "../../web/index.html" with { type: "file" };

const INDEX_PATH = indexHtml as unknown as string;

export async function serveStatic(req: Request): Promise<Response | null> {
  const url = new URL(req.url);
  if (url.pathname.startsWith("/api/")) return null; // let the API handler take it
  if (req.method !== "GET") return null;
  return new Response(Bun.file(INDEX_PATH), {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
