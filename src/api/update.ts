// Update check: ask the GitHub Releases API for the latest published release and compare it to the
// running version. This module is the check only — it never touches the running binary; the actual
// in-place install lives in self-update.ts. The UI surfaces a banner and, when `canInstall` is true
// (compiled binary on a supported platform with an asset for it), an "Update & Restart" button. Pure
// helpers are unit-tested; the one I/O function takes an injected fetcher so it's testable offline.

export interface ReleaseInfo {
  version: string; // tag without a leading "v"
  releaseUrl: string; // the release's html page
  assets: { name: string; url: string }[];
}

export interface UpdateStatus {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  downloadUrl: string | null; // the asset for the caller's platform, when one exists
  releaseUrl: string | null;
  canInstall: boolean; // true → the app can update itself in place (see self-update.ts); else the UI links to the download
  checksumsUrl: string | null; // the release's checksums.txt asset, when present — the installer verifies SHA-256 against it
  error: string | null; // set when the check couldn't complete (offline, rate-limited, malformed)
}

/** Compare two dotted numeric versions (a leading "v" is ignored). Missing parts count as 0. Returns
 * -1 / 0 / 1. Any non-numeric suffix on a part is dropped (best-effort; pre-release tags aren't a
 * concern for this project's simple vMAJOR.MINOR.PATCH tags). */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) =>
    v.replace(/^v/, "").split(".").map((p) => parseInt(p, 10) || 0);
  const pa = parts(a);
  const pb = parts(b);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** The release asset name for a platform/arch — matching scripts/build.ts / the release workflow.
 * Returns null for platforms we don't publish a build for (e.g. Linux). */
export function expectedAssetName(platform: string, arch: string): string | null {
  if (platform === "win32") return "trade-review-windows-x64.exe";
  if (platform === "darwin") return arch === "arm64" ? "trade-review-macos-arm64.zip" : "trade-review-macos-x64.zip";
  return null;
}

/** A URL we're willing to render as a link / hand to the browser: https on github.com only. Anything
 * else (a `javascript:` scheme, an off-site host) is rejected — the banner's Download link is
 * user-trusted, so even a hypothetical GitHub-API compromise can't point it off github.com. */
function safeGithubUrl(u: unknown): string | null {
  if (typeof u !== "string") return null;
  try {
    const url = new URL(u);
    return url.protocol === "https:" && url.hostname === "github.com" ? u : null;
  } catch {
    return null;
  }
}

/** Extract the fields we need from the GitHub `releases/latest` payload; null if it isn't shaped as
 * expected (so a GitHub change / error body degrades to "couldn't check" rather than throwing). */
export function parseRelease(json: unknown): ReleaseInfo | null {
  if (json === null || typeof json !== "object") return null;
  const o = json as Record<string, unknown>;
  if (typeof o.tag_name !== "string") return null;
  const releaseUrl = safeGithubUrl(o.html_url) ?? "";
  const rawAssets = Array.isArray(o.assets) ? o.assets : [];
  const assets = rawAssets
    .filter((a): a is Record<string, unknown> => a !== null && typeof a === "object")
    .map((ao) => ({ name: typeof ao.name === "string" ? ao.name : "", url: safeGithubUrl(ao.browser_download_url) ?? "" }))
    .filter((a) => a.name.length > 0 && a.url.length > 0);
  return { version: o.tag_name.replace(/^v/, ""), releaseUrl, assets };
}

/** Fold a parsed release (or a failure) into the status the UI renders. */
export function buildUpdateStatus(
  current: string,
  release: ReleaseInfo | null,
  platform: string,
  arch: string,
  error: string | null = null,
  installSupported = false, // set by the caller when running the compiled binary on a self-update platform
): UpdateStatus {
  if (release === null) {
    return { current, latest: null, updateAvailable: false, downloadUrl: null, releaseUrl: null, canInstall: false, checksumsUrl: null, error };
  }
  const updateAvailable = compareVersions(release.version, current) > 0;
  const wantName = expectedAssetName(platform, arch);
  const asset = wantName ? release.assets.find((a) => a.name === wantName) : undefined;
  const downloadUrl = asset?.url ?? null;
  // The installer verifies the download against this when present; releases predating it are still
  // installable (degraded to a header/size sanity check).
  const checksumsUrl = release.assets.find((a) => a.name === "checksums.txt")?.url ?? null;
  return {
    current,
    latest: release.version,
    updateAvailable,
    downloadUrl,
    releaseUrl: release.releaseUrl || null,
    // In-place update needs the compiled binary, a supported platform, AND an asset to fetch. Without
    // a download the UI falls back to the release page link.
    canInstall: installSupported && downloadUrl !== null,
    checksumsUrl,
    error: null,
  };
}

/** Fetch the latest release and produce an UpdateStatus. Never throws — an offline/rate-limited/
 * malformed check returns `updateAvailable: false` with `error` set. `fetchImpl` is injected for tests. */
/** Just the slice of `fetch` this module uses — a plain (url, init) → Response, so test doubles don't
 * have to implement the full `fetch` type (preconnect, overloads, …). */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export async function checkForUpdate(opts: {
  current: string;
  platform: string;
  arch: string;
  repo: string; // "owner/name"
  installSupported?: boolean; // compiled binary on a self-update platform → sets canInstall
  fetchImpl?: FetchLike;
}): Promise<UpdateStatus> {
  const { current, platform, arch, repo } = opts;
  const installSupported = opts.installSupported ?? false;
  const doFetch: FetchLike = opts.fetchImpl ?? fetch;
  try {
    const res = await doFetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "trade-review" },
      signal: AbortSignal.timeout(10_000), // don't let a stalled GitHub hang /api/update/check forever
    });
    if (!res.ok) {
      return buildUpdateStatus(current, null, platform, arch, `GitHub returned ${res.status}`);
    }
    const release = parseRelease(await res.json());
    if (release === null) {
      return buildUpdateStatus(current, null, platform, arch, "unexpected release payload");
    }
    return buildUpdateStatus(current, release, platform, arch, null, installSupported);
  } catch (e) {
    return buildUpdateStatus(current, null, platform, arch, e instanceof Error ? e.message : String(e));
  }
}
