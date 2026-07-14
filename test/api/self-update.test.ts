import { test, expect } from "bun:test";
import {
  installTargetFor,
  resolveTranslocatedExecPath,
  macSwapScript,
  winSwapScript,
  verifyChecksum,
} from "../../src/api/self-update";
import { createHash } from "node:crypto";

test("installTargetFor: macOS resolves the .app bundle three dirs up from the exec path", () => {
  const t = installTargetFor("darwin", "/Applications/Trade Review.app/Contents/MacOS/trade-review");
  expect(t).toEqual({ kind: "macapp", appDir: "/Applications/Trade Review.app" });
});

test("installTargetFor: a mac exec path NOT inside a .app bundle → null (don't guess)", () => {
  expect(installTargetFor("darwin", "/usr/local/bin/trade-review")).toBe(null);
  // right depth but wrong dir names
  expect(installTargetFor("darwin", "/some/where/Foo/Bar/trade-review")).toBe(null);
});

test("installTargetFor: Windows targets the running exe itself", () => {
  const t = installTargetFor("win32", "C:\\Users\\me\\Trade Review\\trade-review.exe");
  expect(t).toEqual({ kind: "winexe", exePath: "C:\\Users\\me\\Trade Review\\trade-review.exe" });
});

test("installTargetFor: unsupported platform → null", () => {
  expect(installTargetFor("linux", "/opt/trade-review/trade-review")).toBe(null);
});

// ---- App Translocation resolution (macOS) ----

// A real-shaped `mount` line for a translocated bundle (source has spaces; mountpoint is a UUID dir).
// The nullfs mountpoint is the UUID dir (…/AppTranslocation/<uuid>); the bundle appears one level
// deeper under "<mountpoint>/d/<App>.app", which is where process.execPath lives.
const TRANSLOCATED_MOUNT =
  "/Users/me/Downloads/Trade Review.app on /private/var/folders/f4/xyz/T/AppTranslocation/A7B0-3FA2 (nullfs, local, nodev, nosuid, read-only, nobrowse, mounted by me)\n" +
  "/dev/disk1s1 on / (apfs, local, journaled)\n";
const TRANSLOCATED_EXEC =
  "/private/var/folders/f4/xyz/T/AppTranslocation/A7B0-3FA2/d/Trade Review.app/Contents/MacOS/trade-review";

test("resolveTranslocatedExecPath: a non-translocated path passes through unchanged", () => {
  const p = "/Applications/Trade Review.app/Contents/MacOS/trade-review";
  expect(resolveTranslocatedExecPath(p, () => "unused")).toBe(p);
});

test("resolveTranslocatedExecPath: resolves the real bundle exec path from the nullfs mount source", () => {
  expect(resolveTranslocatedExecPath(TRANSLOCATED_EXEC, () => TRANSLOCATED_MOUNT)).toBe(
    "/Users/me/Downloads/Trade Review.app/Contents/MacOS/trade-review",
  );
});

test("resolveTranslocatedExecPath: a source path containing ' on ' still resolves (anchors on the last delimiter)", () => {
  const mount =
    "/Users/me/Apps on Ice/Trade Review.app on /private/var/folders/f4/xyz/T/AppTranslocation/A7B0-3FA2 (nullfs, local, read-only)\n";
  const exec = "/private/var/folders/f4/xyz/T/AppTranslocation/A7B0-3FA2/d/Trade Review.app/Contents/MacOS/trade-review";
  expect(resolveTranslocatedExecPath(exec, () => mount)).toBe(
    "/Users/me/Apps on Ice/Trade Review.app/Contents/MacOS/trade-review",
  );
});

test("resolveTranslocatedExecPath: translocated but no matching mount → null (fail safe, don't guess)", () => {
  expect(resolveTranslocatedExecPath(TRANSLOCATED_EXEC, () => "/dev/disk1s1 on / (apfs, local)\n")).toBe(null);
});

test("resolveTranslocatedExecPath: a mount read that throws → null (don't swap the read-only copy)", () => {
  expect(
    resolveTranslocatedExecPath(TRANSLOCATED_EXEC, () => {
      throw new Error("mount failed");
    }),
  ).toBe(null);
});

// ---- swap scripts ----

test("macSwapScript: waits on the pid, gives up (exit 1) past the cap, swaps, and relaunches the BUNDLE", () => {
  const s = macSwapScript({
    pid: 4242,
    appDir: "/Applications/Trade Review.app",
    newApp: "/tmp/staging/unpacked/Trade Review.app",
    marker: "/data/.reopen-silent",
    staging: "/tmp/staging",
    logFile: "/data/update.log",
  });
  expect(s).toContain("kill -0 4242"); // waits for the old process
  expect(s).toContain("exit 1"); // gives up rather than swapping into a live app / on move failure
  expect(s).not.toContain("&& break"); // the old "proceed regardless" fallback is gone
  expect(s).toContain("'/Applications/Trade Review.app'"); // path is shell-quoted (has a space)
  expect(s).toContain("'/Applications/Trade Review.app.bak'"); // rolls the old bundle aside
  expect(s).toContain("> '/data/.reopen-silent'"); // one-shot silent-relaunch marker
  expect(s).toContain("open '/Applications/Trade Review.app'"); // relaunch targets the .app, not the exec
  expect(s).toContain("'/data/update.log'"); // leaves a breadcrumb on failure
  expect(s).toContain("rm -rf '/tmp/staging'"); // cleans up
});

test("winSwapScript: renames the running exe aside, keeps a rollback, waits on the pid, then relaunches", () => {
  const s = winSwapScript({
    pid: 7777,
    exePath: "C:\\App\\trade-review.exe",
    newExe: "C:\\App\\trade-review.exe.new",
    marker: "C:\\data\\.reopen-silent",
    scriptDir: "C:\\tmp\\stg",
    logFile: "C:\\data\\update.log",
  });
  // rename-while-running: set the old exe aside as .old (rollback), then move the new one in
  expect(s).toContain('move /y "C:\\App\\trade-review.exe" "C:\\App\\trade-review.exe.old"');
  expect(s).toContain('move /y "C:\\App\\trade-review.exe.new" "C:\\App\\trade-review.exe"');
  // rollback on a failed swap, and NO infinite retry loop
  expect(s).toContain('move /y "C:\\App\\trade-review.exe.old" "C:\\App\\trade-review.exe"');
  expect(s).not.toContain(":retry");
  expect(s).not.toContain("timeout /t"); // console-less timeout busy-spins; we use ping
  expect(s).toContain("ping -n 2 127.0.0.1");
  // relaunch is gated on the OLD pid exiting (port release), not on the swap
  expect(s).toContain('tasklist /fi "PID eq 7777"');
  expect(s).toContain('"C:\\data\\.reopen-silent"'); // silent-relaunch marker
  expect(s).toContain('start "" "C:\\App\\trade-review.exe"'); // relaunch
});

// ---- checksum verification ----

test("verifyChecksum: matching sha256 line → ok/checked", () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const hex = createHash("sha256").update(bytes).digest("hex");
  const body = `deadbeef${"0".repeat(56)}  other-asset.zip\n${hex}  trade-review-macos-arm64.zip\n`;
  expect(verifyChecksum(bytes, body, "trade-review-macos-arm64.zip")).toEqual({ ok: true, checked: true });
});

test("verifyChecksum: a mismatched hash fails closed", () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const body = `${"a".repeat(64)}  trade-review-macos-arm64.zip\n`;
  const r = verifyChecksum(bytes, body, "trade-review-macos-arm64.zip");
  expect(r.ok).toBe(false);
  expect(r.checked).toBe(true);
});

test("verifyChecksum: asset not listed → degrades (ok but not checked), doesn't block", () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const body = `${"a".repeat(64)}  some-other-file.zip\n`;
  expect(verifyChecksum(bytes, body, "trade-review-macos-arm64.zip")).toEqual({ ok: true, checked: false });
});

test("verifyChecksum: tolerates the `*name` (binary mode) form", () => {
  const bytes = new Uint8Array([9, 9, 9]);
  const hex = createHash("sha256").update(bytes).digest("hex");
  expect(verifyChecksum(bytes, `${hex} *trade-review-windows-x64.exe\n`, "trade-review-windows-x64.exe")).toEqual({
    ok: true,
    checked: true,
  });
});
