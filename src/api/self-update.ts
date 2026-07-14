// In-place self-update: download the platform's release asset from github.com and swap the running
// binary for it, then relaunch — no manual re-download. A running process can't overwrite its own
// live image, so the swap is handed to a DETACHED helper script that waits for us to exit, replaces
// the app/exe, and relaunches it. The heavy, fallible work (download/unzip/verify) runs synchronously
// so failures surface as a 500 BEFORE we shut down; only the atomic swap is deferred to the script.
//
// Data safety: the SQLite DB lives in the user-data dir, never inside the app bundle/exe, so swapping
// the binary can't touch it (see store/paths.ts). We only ever fetch from github.com (re-validated
// below); a programmatic fetch sets no macOS quarantine xattr, so the relaunched .app isn't blocked
// by Gatekeeper. Pure helpers (installTargetFor + the script builders) are unit-tested; performInstall
// is the thin I/O shell.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readdirSync, existsSync, statSync, chmodSync, rmSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import type { UpdateStatus } from "./update";

/** What we're replacing on disk, derived from the running executable's path. macOS ships a `.app`
 * bundle (exec path is `…/Trade Review.app/Contents/MacOS/trade-review`, so the bundle root is three
 * dirs up); Windows ships the bare `.exe` (the exec path itself). Returns null on platforms/layouts
 * we don't self-update (Linux, or a mac exec path not inside a `.app`). Pure — unit-tested. */
export type InstallTarget =
  | { kind: "macapp"; appDir: string } // the `.app` bundle directory to replace
  | { kind: "winexe"; exePath: string }; // the running `.exe` to replace

export function installTargetFor(platform: string, execPath: string): InstallTarget | null {
  if (platform === "darwin") {
    // …/Trade Review.app/Contents/MacOS/trade-review → …/Trade Review.app
    const macOsDir = dirname(execPath); // …/Contents/MacOS
    const contentsDir = dirname(macOsDir); // …/Contents
    const appDir = dirname(contentsDir); // …/Trade Review.app
    if (basename(macOsDir) !== "MacOS" || basename(contentsDir) !== "Contents" || !appDir.endsWith(".app")) {
      return null; // not laid out as a bundle (e.g. a loose binary) — don't guess
    }
    return { kind: "macapp", appDir };
  }
  if (platform === "win32") {
    return { kind: "winexe", exePath: execPath };
  }
  return null;
}

/** POSIX-shell single-quote a string (wrap in '…', escaping embedded quotes). Paths can contain
 * spaces ("Trade Review.app"), so every interpolated path in the sh script goes through this. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Windows batch: quote a path and escape the few metacharacters that matter inside a double-quoted
 * argument. Batch has no real escaping; we reject paths containing `"` upstream to keep this sound. */
function batq(s: string): string {
  return `"${s}"`;
}

/** macOS swap script (sh): wait for the running app (pid) to exit, replace the `.app`, mark the next
 * launch as silent, relaunch via `open` (LaunchServices → keeps the Dock icon), then clean up. */
export function macSwapScript(o: { pid: number; appDir: string; newApp: string; marker: string; staging: string }): string {
  const app = shq(o.appDir);
  const bak = shq(`${o.appDir}.bak`);
  return `#!/bin/sh
# Trade Review in-place update. Wait for the old process to exit so the relaunch can bind the port.
i=0
while kill -0 ${o.pid} 2>/dev/null; do
  sleep 0.2
  i=$((i+1))
  [ "$i" -gt 300 ] && break   # ~60s safety cap; proceed regardless
done
rm -rf ${bak}
if ! mv ${app} ${bak}; then
  exit 1                       # couldn't move the old bundle aside — leave everything as-is
fi
if ! mv ${shq(o.newApp)} ${app}; then
  mv ${bak} ${app}             # roll back to the working version
  exit 1
fi
rm -rf ${bak}
: > ${shq(o.marker)}           # one-shot marker: the relaunched app skips opening a 2nd browser tab
open ${app}
rm -rf ${shq(o.staging)}
rm -f "$0"
`;
}

/** Windows swap script (.cmd): retry moving the new exe over the target until it succeeds — the move
 * is blocked while the old process holds the exe, so this naturally waits for exit. Then mark the
 * next launch silent, relaunch, and clean up. */
export function winSwapScript(o: { exePath: string; newExe: string; marker: string; staging: string }): string {
  const target = batq(o.exePath);
  return `@echo off
rem Trade Review in-place update. Retry until the old process releases its lock on the exe.
:retry
move /y ${batq(o.newExe)} ${target} >nul 2>&1
if errorlevel 1 (
  timeout /t 1 /nobreak >nul 2>&1
  goto retry
)
rem One-shot marker: the relaunched app skips opening a 2nd browser tab.
break > ${batq(o.marker)}
start "" ${target}
rmdir /s /q ${batq(o.staging)} >nul 2>&1
(goto) 2>nul & del "%~f0"
`;
}

/** A url we're willing to fetch: https on github.com only. Defense in depth — the download url already
 * came from update.ts's github-only parser, but the installer executes what it downloads, so it
 * re-validates rather than trusting the caller. */
function isGithubHttps(u: string): boolean {
  try {
    const url = new URL(u);
    return url.protocol === "https:" && url.hostname === "github.com";
  } catch {
    return false;
  }
}

const MIN_ASSET_BYTES = 1_000_000; // a real build is tens of MB; anything tiny is a truncated/HTML error body

export interface InstallResult {
  ok: boolean;
  error?: string;
}

/** Download the platform asset, stage + verify it, and spawn the detached swap script. On success the
 * caller shuts the app down (the script waits for that, then swaps + relaunches). Never throws — any
 * failure returns { ok:false, error } and the app keeps running. */
export async function performInstall(opts: {
  status: UpdateStatus;
  platform: string;
  execPath: string;
  pid: number;
  marker: string; // <dataDir>/.reopen-silent — the swap script touches this so the relaunch is silent
  compiled: boolean;
  fetchImpl?: (url: string) => Promise<Response>;
}): Promise<InstallResult> {
  try {
    if (!opts.compiled) return { ok: false, error: "in-place update only works in the packaged app, not from source" };
    const target = installTargetFor(opts.platform, opts.execPath);
    if (!target) return { ok: false, error: `in-place update is not supported on ${opts.platform}` };
    const url = opts.status.downloadUrl;
    if (!url) return { ok: false, error: "no download is available for this platform" };
    if (!isGithubHttps(url)) return { ok: false, error: "refusing to download from a non-github.com URL" };
    // Batch quoting is not robust against a `"` in a path; refuse rather than build a broken script.
    if (opts.platform === "win32" && (opts.execPath.includes('"') || opts.marker.includes('"'))) {
      return { ok: false, error: "install path contains a character we can't safely script around" };
    }

    const doFetch = opts.fetchImpl ?? ((u: string) => fetch(u));
    const staging = mkdtempSync(join(tmpdir(), "trade-review-update-"));

    // Download the asset to the staging dir.
    const res = await doFetch(url);
    if (!res.ok) return { ok: false, error: `download failed: GitHub returned ${res.status}` };
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength < MIN_ASSET_BYTES) {
      return { ok: false, error: `download looks truncated (${bytes.byteLength} bytes)` };
    }

    let scriptPath: string;
    let scriptBody: string;
    if (target.kind === "macapp") {
      const zipPath = join(staging, "update.zip");
      writeFileSync(zipPath, bytes);
      // ditto preserves the bundle structure + the ad-hoc signature the release was signed with.
      const unzipDir = join(staging, "unpacked");
      const unzip = spawn("ditto", ["-x", "-k", zipPath, unzipDir]);
      const code: number = await new Promise((resolve) => {
        unzip.on("error", () => resolve(-1));
        unzip.on("exit", (c) => resolve(c ?? -1));
      });
      if (code !== 0) return { ok: false, error: "could not unpack the downloaded update" };
      const appName = readdirSync(unzipDir).find((n) => n.endsWith(".app"));
      if (!appName) return { ok: false, error: "the downloaded update did not contain an app bundle" };
      const newApp = join(unzipDir, appName);
      if (!existsSync(join(newApp, "Contents", "MacOS", "trade-review"))) {
        return { ok: false, error: "the downloaded app bundle is missing its executable" };
      }
      scriptBody = macSwapScript({ pid: opts.pid, appDir: target.appDir, newApp, marker: opts.marker, staging });
      scriptPath = join(staging, "swap.sh");
    } else {
      const newExe = join(staging, "trade-review-new.exe");
      writeFileSync(newExe, bytes);
      scriptBody = winSwapScript({ exePath: target.exePath, newExe, marker: opts.marker, staging });
      scriptPath = join(staging, "swap.cmd");
    }

    writeFileSync(scriptPath, scriptBody);
    if (target.kind === "macapp") chmodSync(scriptPath, 0o755);

    // Spawn the swap script fully detached so it outlives this process (which is about to exit).
    const child =
      target.kind === "macapp"
        ? spawn("/bin/sh", [scriptPath], { detached: true, stdio: "ignore" })
        : spawn("cmd.exe", ["/c", scriptPath], { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => {}); // an async spawn error must not crash us mid-shutdown
    child.unref();

    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Consume the one-shot "relaunched by the updater" marker: returns true (and deletes it) when the
 * current launch should NOT open a browser tab. Kept here so app.ts and the installer share the path
 * convention. Best-effort — a read/delete failure just falls back to opening the tab. */
export function consumeSilentRelaunchMarker(markerPath: string): boolean {
  try {
    if (!existsSync(markerPath)) return false;
    // Stale-guard: ignore a marker older than a few minutes (a prior update that never relaunched).
    const ageMs = Date.now() - statSync(markerPath).mtimeMs;
    rmSync(markerPath, { force: true });
    return ageMs < 5 * 60_000;
  } catch {
    return false;
  }
}
