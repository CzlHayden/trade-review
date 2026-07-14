// In-place self-update: download the platform's release asset from github.com and swap the running
// binary for it, then relaunch — no manual re-download. A running process can't overwrite its own
// live image, so the swap is handed to a DETACHED helper script that waits for us to exit, replaces
// the app/exe, and relaunches it. The heavy, fallible work (download/unzip/verify) runs synchronously
// so failures surface as a 500 BEFORE we shut down; only the atomic swap is deferred to the script.
//
// Data safety: the SQLite DB lives in the user-data dir, never inside the app bundle/exe, so swapping
// the binary can't touch it (see store/paths.ts); nothing in the app reads bundle-relative paths at
// runtime, so replacing the bundle can't disrupt a shutting-down process. We only ever fetch from
// github.com (re-validated below); a programmatic fetch sets no macOS quarantine xattr, so the
// relaunched .app isn't blocked by Gatekeeper. Pure helpers (installTargetFor, the translocation
// resolver, the script builders, the checksum verifier) are unit-tested; performInstall is the thin
// I/O shell.
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, readdirSync, existsSync, statSync, chmodSync, rmSync, appendFileSync } from "node:fs";
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

/** macOS App Translocation: a quarantined, ad-hoc-signed app launched from Finder runs from a
 * read-only randomized nullfs mount (…/AppTranslocation/<uuid>/d/<App>.app), so `process.execPath`
 * points into an ephemeral copy we can't overwrite. Resolve the REAL bundle's exec path from the live
 * mount table — the translocation mount's SOURCE is the original bundle — so the swap targets the
 * writable original. (SecTranslocateCreateOriginalPathForURL returns the same answer, but needs FFI
 * into a private Security.framework symbol; the mount table is text but needs no native binding, and
 * an unresolved case fails safe rather than swapping the wrong path.)
 *
 * Returns execPath unchanged when not translocated; the resolved real exec path when it can; and null
 * when translocated but unresolvable — the caller then refuses with an actionable message instead of
 * swapping the read-only copy. `readMounts` is injected for tests. Pure aside from the mount read. */
export function resolveTranslocatedExecPath(
  execPath: string,
  readMounts: () => string = () => execFileSync("/sbin/mount", { encoding: "utf8" }),
): string | null {
  if (!execPath.includes("/AppTranslocation/")) return execPath;
  let mounts: string;
  try {
    mounts = readMounts();
  } catch {
    return null;
  }
  for (const line of mounts.split("\n")) {
    // Format: "<source> on <mountpoint> (nullfs, local, …, read-only, …)". Paths contain spaces, so
    // anchor on " on " + the "(nullfs" options rather than splitting on whitespace.
    const optIdx = line.indexOf(" (nullfs");
    if (optIdx < 0) continue;
    const onIdx = line.indexOf(" on ");
    if (onIdx < 0 || onIdx >= optIdx) continue;
    const source = line.slice(0, onIdx); // the original bundle
    const mountpoint = line.slice(onIdx + 4, optIdx); // …/AppTranslocation/<uuid>
    if (!execPath.startsWith(mountpoint + "/")) continue;
    // The bundle appears under "<mountpoint>/d/<basename(source)>"; map that prefix back to <source>.
    const rel = execPath.slice(mountpoint.length); // "/d/<App>.app/Contents/MacOS/<bin>"
    const marker = `/d/${basename(source)}/`;
    if (!rel.startsWith(marker)) continue;
    return source + rel.slice(marker.length - 1); // "<source>/Contents/MacOS/<bin>"
  }
  return null;
}

/** POSIX-shell single-quote a string (wrap in '…', escaping embedded quotes). Paths can contain
 * spaces ("Trade Review.app"), so every interpolated path in the sh script goes through this. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Windows batch: quote a path. Batch has no real escaping; we reject paths containing `"`, `%`, or
 * `!` upstream (performInstall) so double-quoting is sound. */
function batq(s: string): string {
  return `"${s}"`;
}

/** macOS swap script (sh): wait for the running app (pid) to exit, replace the `.app`, mark the next
 * launch as silent, relaunch via `open` (LaunchServices → keeps the Dock icon), then clean up. If the
 * old process never exits we GIVE UP (leave everything working) rather than swap into a live app — a
 * relaunch then can't bind the port and would kill the new process, leaving nothing running. */
export function macSwapScript(o: { pid: number; appDir: string; newApp: string; marker: string; staging: string; logFile: string }): string {
  const app = shq(o.appDir);
  const bak = shq(`${o.appDir}.bak`);
  const log = shq(o.logFile);
  return `#!/bin/sh
# Trade Review in-place update. Wait for the old process to exit so the relaunch can bind the port.
i=0
while kill -0 ${o.pid} 2>/dev/null; do
  sleep 0.2
  i=$((i+1))
  if [ "$i" -gt 300 ]; then
    echo "$(date): update aborted — old process (pid ${o.pid}) still running after 60s" >> ${log}
    exit 1                       # give up: swapping into a live app would leave nothing running
  fi
done
rm -rf ${bak}
if ! mv ${app} ${bak}; then
  echo "$(date): update aborted — could not move the old bundle aside" >> ${log}
  exit 1                       # couldn't move the old bundle aside — leave everything as-is
fi
if ! mv ${shq(o.newApp)} ${app}; then
  mv ${bak} ${app}             # roll back to the working version
  echo "$(date): update aborted — could not move the new bundle into place; rolled back" >> ${log}
  exit 1
fi
rm -rf ${bak}
: > ${shq(o.marker)}           # one-shot marker: the relaunched app skips opening a 2nd browser tab
open ${app}
rm -rf ${shq(o.staging)}
rm -f "$0"
`;
}

/** Windows swap script (.cmd): rename-while-running (a running .exe CAN be renamed, so this needs no
 * wait-for-unlock and can't hang). Set the old exe aside as `.old` (kept as a rollback the new build
 * deletes on its first successful start), move the new exe into place, then wait for the old process
 * to exit — releasing port ${"${port}"} — before relaunching. On any move failure we roll back and exit;
 * we never loop forever. `ping` is the sleep (`timeout` needs a console this detached script lacks). */
export function winSwapScript(o: { pid: number; exePath: string; newExe: string; marker: string; scriptDir: string; logFile: string }): string {
  const target = batq(o.exePath);
  const old = batq(`${o.exePath}.old`);
  const log = batq(o.logFile);
  return `@echo off
rem Trade Review in-place update.
del /f /q ${old} >nul 2>&1
move /y ${target} ${old} >nul 2>&1
if errorlevel 1 (
  echo %date% %time% update aborted - could not set the old exe aside >> ${log}
  goto cleanup
)
move /y ${batq(o.newExe)} ${target} >nul 2>&1
if errorlevel 1 (
  move /y ${old} ${target} >nul 2>&1
  echo %date% %time% update aborted - could not move the new exe into place; rolled back >> ${log}
  goto cleanup
)
rem Wait (bounded) for the old process to exit so it releases the port, then relaunch.
set /a n=0
:waitexit
tasklist /fi "PID eq ${o.pid}" 2>nul | find "${o.pid}" >nul
if errorlevel 1 goto relaunch
ping -n 2 127.0.0.1 >nul 2>&1
set /a n+=1
if %n% lss 60 goto waitexit
:relaunch
rem One-shot marker: the relaunched app skips opening a 2nd browser tab.
break > ${batq(o.marker)}
start "" ${target}
:cleanup
rmdir /s /q ${batq(o.scriptDir)} >nul 2>&1
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

/** Verify a downloaded asset against a `checksums.txt` body (sha256sum format: "<hex>  <name>", the
 * name optionally `*`-prefixed for binary mode). Returns ok when the asset's line matches OR when the
 * asset isn't listed (degraded: a release-process gap shouldn't block updating, and TLS-to-github
 * already covers transport) — only a real HASH MISMATCH fails. Pure — unit-tested. */
export function verifyChecksum(bytes: Uint8Array, checksumsText: string, assetName: string): { ok: boolean; error?: string; checked: boolean } {
  for (const line of checksumsText.split("\n")) {
    const m = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (!m) continue;
    if (m[2] !== assetName) continue;
    const want = m[1]!.toLowerCase();
    const got = createHash("sha256").update(bytes).digest("hex");
    if (got !== want) return { ok: false, checked: true, error: "the download's checksum did not match the release — aborting to protect the install" };
    return { ok: true, checked: true };
  }
  return { ok: true, checked: false }; // asset not listed — degrade rather than block
}

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
  port: number; // the port the relaunched app must be able to bind (informational, for the win script comment)
  marker: string; // <dataDir>/.reopen-silent — the swap script touches this so the relaunch is silent
  compiled: boolean;
  fetchImpl?: (url: string) => Promise<Response>;
}): Promise<InstallResult> {
  const logFile = join(dirname(opts.marker), "update.log");
  const log = (msg: string) => {
    try {
      appendFileSync(logFile, `${new Date().toISOString()} ${msg}\n`);
    } catch {
      /* best-effort breadcrumb */
    }
  };
  // A failed attempt must not leave a stale silent-relaunch marker behind (a later manual launch would
  // then open with no browser tab — invisible on Windows). Clear it on every failure path.
  const fail = (error: string): InstallResult => {
    try {
      rmSync(opts.marker, { force: true });
    } catch {
      /* ignore */
    }
    log(`install failed: ${error}`);
    return { ok: false, error };
  };
  try {
    if (!opts.compiled) return fail("in-place update only works in the packaged app, not from source");

    // macOS: if we're translocated, resolve the REAL bundle path before deriving the swap target. An
    // unresolvable translocation must NOT fall through to swapping the read-only copy.
    const realExec = opts.platform === "darwin" ? resolveTranslocatedExecPath(opts.execPath) : opts.execPath;
    if (realExec === null) {
      return fail(
        "Trade Review is running from a temporary location macOS created for a downloaded app, so it can't update itself in place. Move Trade Review to your Applications folder (or drag it out of Downloads) and reopen it, then try again.",
      );
    }

    const target = installTargetFor(opts.platform, realExec);
    if (!target) return fail(`in-place update is not supported on ${opts.platform}`);
    const url = opts.status.downloadUrl;
    if (!url) return fail("no download is available for this platform");
    if (!isGithubHttps(url)) return fail("refusing to download from a non-github.com URL");
    // Batch quoting isn't robust against `"`, `%` (expands even inside quotes), or `!` (delayed
    // expansion); refuse rather than build a broken/dangerous script.
    if (target.kind === "winexe" && /["%!]/.test(target.exePath + opts.marker + logFile)) {
      return fail("install path contains a character we can't safely script around");
    }

    const doFetch = opts.fetchImpl ?? ((u: string) => fetch(u));

    // Download the asset.
    const res = await doFetch(url);
    if (!res.ok) return fail(`download failed: GitHub returned ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength < MIN_ASSET_BYTES) {
      return fail(`download looks truncated (${bytes.byteLength} bytes)`);
    }

    // Integrity: verify against the release's checksums.txt when the check advertised one.
    if (opts.status.checksumsUrl && isGithubHttps(opts.status.checksumsUrl)) {
      const cres = await doFetch(opts.status.checksumsUrl);
      if (cres.ok) {
        const v = verifyChecksum(bytes, await cres.text(), basename(new URL(url).pathname));
        if (!v.ok) return fail(v.error ?? "checksum verification failed");
        if (!v.checked) log("checksums.txt present but this asset was not listed — installed without a checksum match");
      } else {
        log(`could not fetch checksums.txt (GitHub returned ${cres.status}) — installing without a checksum match`);
      }
    }

    let scriptPath: string;
    let scriptBody: string;
    let scriptDir: string; // detached script lives here; deleted by the script itself where possible
    if (target.kind === "macapp") {
      scriptDir = mkdtempSync(join(tmpdir(), "trade-review-update-"));
      const zipPath = join(scriptDir, "update.zip");
      writeFileSync(zipPath, bytes);
      // ditto preserves the bundle structure + the ad-hoc signature the release was signed with.
      const unzipDir = join(scriptDir, "unpacked");
      const unzip = spawn("ditto", ["-x", "-k", zipPath, unzipDir]);
      const code: number = await new Promise((resolve) => {
        unzip.on("error", () => resolve(-1));
        unzip.on("exit", (c) => resolve(c ?? -1));
      });
      if (code !== 0) return fail("could not unpack the downloaded update");
      const appName = readdirSync(unzipDir).find((n) => n.endsWith(".app"));
      if (!appName) return fail("the downloaded update did not contain an app bundle");
      const newApp = join(unzipDir, appName);
      if (!existsSync(join(newApp, "Contents", "MacOS", "trade-review"))) {
        return fail("the downloaded app bundle is missing its executable");
      }
      scriptBody = macSwapScript({ pid: opts.pid, appDir: target.appDir, newApp, marker: opts.marker, staging: scriptDir, logFile });
      scriptPath = join(scriptDir, "swap.sh");
    } else {
      // Windows: a bare .exe. Reject a non-PE payload (HTML error body, wrong asset) before we ever
      // touch the running exe. Stage the new exe IN THE TARGET'S DIRECTORY so the swap is a same-volume
      // atomic rename (no cross-volume copy that could die mid-write and brick the install), and a
      // non-writable install dir fails HERE, cleanly, while the app is still running.
      if (bytes[0] !== 0x4d || bytes[1] !== 0x5a) return fail("the downloaded file is not a Windows executable");
      const newExe = `${target.exePath}.new`;
      try {
        writeFileSync(newExe, bytes);
      } catch (e) {
        return fail(`can't stage the update next to the app (${e instanceof Error ? e.message : String(e)}) — is the install folder writable?`);
      }
      scriptDir = mkdtempSync(join(tmpdir(), "trade-review-update-"));
      scriptBody = winSwapScript({ pid: opts.pid, exePath: target.exePath, newExe, marker: opts.marker, scriptDir, logFile });
      scriptPath = join(scriptDir, "swap.cmd");
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

    log(`install started → ${opts.status.latest ?? "?"}`);
    return { ok: true };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
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

/** Best-effort cleanup of a prior Windows update's rollback copy (`<exe>.old`). Reaching startup means
 * the new build launched successfully, so the rollback is no longer needed. No-op elsewhere. */
export function sweepUpdateArtifacts(platform: string, execPath: string): void {
  if (platform !== "win32") return;
  try {
    rmSync(`${execPath}.old`, { force: true });
  } catch {
    /* ignore — a locked/absent .old is harmless */
  }
}
