import { test, expect } from "bun:test";
import { installTargetFor, macSwapScript, winSwapScript } from "../../src/api/self-update";

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

test("macSwapScript: waits on the pid, swaps the bundle, marks silent, and relaunches via open", () => {
  const s = macSwapScript({
    pid: 4242,
    appDir: "/Applications/Trade Review.app",
    newApp: "/tmp/staging/unpacked/Trade Review.app",
    marker: "/data/.reopen-silent",
    staging: "/tmp/staging",
  });
  expect(s).toContain("kill -0 4242"); // waits for the old process
  expect(s).toContain("'/Applications/Trade Review.app'"); // path is shell-quoted (has a space)
  expect(s).toContain("'/Applications/Trade Review.app.bak'"); // rolls the old bundle aside
  expect(s).toContain("> '/data/.reopen-silent'"); // one-shot silent-relaunch marker
  expect(s).toContain("open '/Applications/Trade Review.app'"); // relaunch via LaunchServices
  expect(s).toContain("rm -rf '/tmp/staging'"); // cleans up
});

test("winSwapScript: retries the move (waits for the exe lock), marks silent, and relaunches", () => {
  const s = winSwapScript({
    exePath: "C:\\App\\trade-review.exe",
    newExe: "C:\\tmp\\stg\\trade-review-new.exe",
    marker: "C:\\data\\.reopen-silent",
    staging: "C:\\tmp\\stg",
  });
  expect(s).toContain(":retry"); // loops until the old exe releases its lock
  expect(s).toContain('move /y "C:\\tmp\\stg\\trade-review-new.exe" "C:\\App\\trade-review.exe"');
  expect(s).toContain('"C:\\data\\.reopen-silent"'); // silent-relaunch marker
  expect(s).toContain('start "" "C:\\App\\trade-review.exe"'); // relaunch
  expect(s).toContain('rmdir /s /q "C:\\tmp\\stg"'); // cleans up
});
