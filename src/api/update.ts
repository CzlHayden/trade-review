// Update check: ask the GitHub Releases API for the latest published release and compare it to the
// running version. This is NOTIFY-ONLY — it never touches the running binary. The UI surfaces a
// banner with a download link; the user installs the new build themselves (see README). Pure helpers
// are unit-tested; the one I/O function takes an injected fetcher so it's testable offline.

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

/** Extract the fields we need from the GitHub `releases/latest` payload; null if it isn't shaped as
 * expected (so a GitHub change / error body degrades to "couldn't check" rather than throwing). */
export function parseRelease(json: unknown): ReleaseInfo | null {
  if (json === null || typeof json !== "object") return null;
  const o = json as Record<string, unknown>;
  if (typeof o.tag_name !== "string") return null;
  const releaseUrl = typeof o.html_url === "string" ? o.html_url : "";
  const rawAssets = Array.isArray(o.assets) ? o.assets : [];
  const assets = rawAssets
    .map((a) => {
      const ao = a as Record<string, unknown>;
      return { name: typeof ao.name === "string" ? ao.name : "", url: typeof ao.browser_download_url === "string" ? ao.browser_download_url : "" };
    })
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
): UpdateStatus {
  if (release === null) {
    return { current, latest: null, updateAvailable: false, downloadUrl: null, releaseUrl: null, error };
  }
  const updateAvailable = compareVersions(release.version, current) > 0;
  const wantName = expectedAssetName(platform, arch);
  const asset = wantName ? release.assets.find((a) => a.name === wantName) : undefined;
  return {
    current,
    latest: release.version,
    updateAvailable,
    downloadUrl: asset?.url ?? null,
    releaseUrl: release.releaseUrl || null,
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
  fetchImpl?: FetchLike;
}): Promise<UpdateStatus> {
  const { current, platform, arch, repo } = opts;
  const doFetch: FetchLike = opts.fetchImpl ?? fetch;
  try {
    const res = await doFetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "trade-review" },
    });
    if (!res.ok) {
      return buildUpdateStatus(current, null, platform, arch, `GitHub returned ${res.status}`);
    }
    const release = parseRelease(await res.json());
    if (release === null) {
      return buildUpdateStatus(current, null, platform, arch, "unexpected release payload");
    }
    return buildUpdateStatus(current, release, platform, arch);
  } catch (e) {
    return buildUpdateStatus(current, null, platform, arch, e instanceof Error ? e.message : String(e));
  }
}
