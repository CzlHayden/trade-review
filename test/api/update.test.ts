import { test, expect } from "bun:test";
import {
  compareVersions,
  expectedAssetName,
  parseRelease,
  buildUpdateStatus,
  checkForUpdate,
} from "../../src/api/update";

test("compareVersions orders semver-ish versions and ignores a leading v", () => {
  expect(compareVersions("0.7.0", "0.6.0")).toBe(1);
  expect(compareVersions("v0.6.0", "0.6.0")).toBe(0);
  expect(compareVersions("0.6.1", "0.6.10")).toBe(-1); // numeric, not lexical
  expect(compareVersions("1.0.0", "0.9.9")).toBe(1);
  expect(compareVersions("0.6.0", "0.6")).toBe(0); // missing parts treated as 0
});

test("expectedAssetName maps platform/arch to the release asset name", () => {
  expect(expectedAssetName("win32", "x64")).toBe("trade-review-windows-x64.exe");
  expect(expectedAssetName("darwin", "arm64")).toBe("trade-review-macos-arm64.zip");
  expect(expectedAssetName("darwin", "x64")).toBe("trade-review-macos-x64.zip");
  expect(expectedAssetName("linux", "x64")).toBe(null); // no linux asset published
});

test("parseRelease pulls tag, html_url, and assets from the GitHub payload", () => {
  const rel = parseRelease({
    tag_name: "v0.7.0",
    html_url: "https://github.com/keithzrc/trade-review/releases/tag/v0.7.0",
    assets: [
      { name: "trade-review-macos-arm64.zip", browser_download_url: "https://github.com/x/arm64.zip" },
      { name: "trade-review-windows-x64.exe", browser_download_url: "https://github.com/x/win.exe" },
    ],
  });
  expect(rel).toEqual({
    version: "0.7.0",
    releaseUrl: "https://github.com/keithzrc/trade-review/releases/tag/v0.7.0",
    assets: [
      { name: "trade-review-macos-arm64.zip", url: "https://github.com/x/arm64.zip" },
      { name: "trade-review-windows-x64.exe", url: "https://github.com/x/win.exe" },
    ],
  });
});

test("parseRelease returns null on a malformed payload", () => {
  expect(parseRelease(null)).toBe(null);
  expect(parseRelease({})).toBe(null); // no tag_name
  expect(parseRelease({ tag_name: 5 })).toBe(null);
});

test("parseRelease skips null/primitive asset entries without throwing", () => {
  const rel = parseRelease({
    tag_name: "v0.7.0",
    html_url: "https://github.com/keithzrc/trade-review/releases/tag/v0.7.0",
    assets: [null, 42, { name: "trade-review-macos-arm64.zip", browser_download_url: "https://github.com/x/arm64.zip" }],
  });
  expect(rel?.assets).toEqual([{ name: "trade-review-macos-arm64.zip", url: "https://github.com/x/arm64.zip" }]);
});

test("parseRelease drops non-github / non-https URLs (no off-site or javascript: links)", () => {
  const rel = parseRelease({
    tag_name: "v0.7.0",
    html_url: "javascript:alert(1)", // hostile release page → dropped to ""
    assets: [
      { name: "evil.exe", browser_download_url: "https://evil.example/evil.exe" }, // wrong host → dropped
      { name: "js.exe", browser_download_url: "javascript:alert(1)" }, // scheme → dropped
      { name: "trade-review-windows-x64.exe", browser_download_url: "https://github.com/x/win.exe" }, // kept
    ],
  });
  expect(rel?.releaseUrl).toBe("");
  expect(rel?.assets).toEqual([{ name: "trade-review-windows-x64.exe", url: "https://github.com/x/win.exe" }]);
});

test("buildUpdateStatus flags an available update and picks this platform's download", () => {
  const release = {
    version: "0.7.0",
    releaseUrl: "https://rel",
    assets: [{ name: "trade-review-macos-arm64.zip", url: "https://dl/arm64.zip" }],
  };
  const s = buildUpdateStatus("0.6.0", release, "darwin", "arm64");
  expect(s).toEqual({
    current: "0.6.0",
    latest: "0.7.0",
    updateAvailable: true,
    downloadUrl: "https://dl/arm64.zip",
    releaseUrl: "https://rel",
    canInstall: false, // installSupported defaults to false
    error: null,
  });
});

test("buildUpdateStatus: canInstall only when installSupported AND an asset exists for this platform", () => {
  const withAsset = {
    version: "0.7.0",
    releaseUrl: "https://rel",
    assets: [{ name: "trade-review-macos-arm64.zip", url: "https://dl/arm64.zip" }],
  };
  // installSupported + matching asset → true
  expect(buildUpdateStatus("0.6.0", withAsset, "darwin", "arm64", null, true).canInstall).toBe(true);
  // installSupported but NO asset for this platform → false (nothing to download)
  expect(buildUpdateStatus("0.6.0", withAsset, "linux", "x64", null, true).canInstall).toBe(false);
  // asset present but not a self-update platform/build → false (falls back to a download link)
  expect(buildUpdateStatus("0.6.0", withAsset, "darwin", "arm64", null, false).canInstall).toBe(false);
});

test("buildUpdateStatus: same version → no update; downloadUrl null when this platform's asset is absent", () => {
  const release = {
    version: "0.6.0",
    releaseUrl: "https://rel",
    assets: [{ name: "trade-review-windows-x64.exe", url: "https://dl/win.exe" }],
  };
  const s = buildUpdateStatus("0.6.0", release, "darwin", "arm64");
  expect(s.updateAvailable).toBe(false);
  expect(s.downloadUrl).toBe(null); // no macOS asset in this (hypothetical) release
  expect(s.latest).toBe("0.6.0");
});

test("buildUpdateStatus surfaces a failed check without claiming an update", () => {
  const s = buildUpdateStatus("0.6.0", null, "darwin", "arm64", "network error");
  expect(s).toEqual({
    current: "0.6.0",
    latest: null,
    updateAvailable: false,
    downloadUrl: null,
    releaseUrl: null,
    canInstall: false,
    error: "network error",
  });
});

test("checkForUpdate: happy path uses the injected fetcher and reports an update", async () => {
  const fetchImpl = async () =>
    new Response(
      JSON.stringify({
        tag_name: "v0.7.0",
        html_url: "https://github.com/o/r/releases/tag/v0.7.0",
        assets: [{ name: "trade-review-macos-arm64.zip", browser_download_url: "https://github.com/o/r/releases/download/v0.7.0/arm64.zip" }],
      }),
      { status: 200 },
    );
  const s = await checkForUpdate({ current: "0.6.0", platform: "darwin", arch: "arm64", repo: "o/r", fetchImpl });
  expect(s.updateAvailable).toBe(true);
  expect(s.downloadUrl).toBe("https://github.com/o/r/releases/download/v0.7.0/arm64.zip");
  expect(s.error).toBe(null);
});

test("checkForUpdate: a non-200 (e.g. rate limit) becomes an error, not an update", async () => {
  const fetchImpl = async () => new Response("rate limited", { status: 403 });
  const s = await checkForUpdate({ current: "0.6.0", platform: "darwin", arch: "arm64", repo: "o/r", fetchImpl });
  expect(s.updateAvailable).toBe(false);
  expect(s.error).not.toBe(null);
  expect(s.current).toBe("0.6.0");
});

test("checkForUpdate: a thrown fetch (offline) becomes an error, not a crash", async () => {
  const fetchImpl = async () => {
    throw new Error("offline");
  };
  const s = await checkForUpdate({ current: "0.6.0", platform: "darwin", arch: "arm64", repo: "o/r", fetchImpl });
  expect(s.updateAvailable).toBe(false);
  expect(s.error).toBe("offline");
});
