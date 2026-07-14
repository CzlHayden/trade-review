# In-place self-update (macOS + Windows) — design

**Date:** 2026-07-13
**Status:** approved, implementing

## Problem

The update banner today is notify-only: clicking **Download** opens the browser to the GitHub
release asset, and the user has to unzip, replace the app, and reopen it by hand. The user wants the
app to update itself — one click, downloads the new build, swaps itself on disk, and relaunches —
like any other desktop app, with no re-download and no risk of data loss.

Separately, revert the `LSUIElement` change (the app now shows a normal Dock icon again; the user
accepts the launch "bounce" tradeoff so the app is visible and not forgotten in the background).

## Guarantees

- **No data loss, no re-wiring.** The SQLite DB lives in the user-data dir
  (`~/Library/Application Support/TradeReview`, `%APPDATA%\TradeReview`, …) — never inside the app
  bundle/exe. Swapping the binary cannot touch it. This is already true (`src/store/paths.ts`); the
  update path just relies on it.
- **Only ever downloads from github.com.** The download URL comes from the GitHub Releases API and is
  already validated to be `https://github.com/...` (`safeGithubUrl` in `update.ts`); the installer
  re-validates before fetching. (GitHub redirects the asset URL to its CDN — following that redirect
  is expected and fine.)
- **No Gatekeeper "damaged" wall.** The zip is fetched programmatically (not via a browser), so macOS
  sets no `com.apple.quarantine` xattr. The already-ad-hoc-signed `.app` relaunches without the
  "unidentified/damaged" dialog.

## Scope

- **macOS** and **Windows** in-place update. Linux / running-from-source keep the current Download
  link (there is no packaged artifact to swap).
- Only offered when running the **compiled binary** (not `bun run src/app.ts`).

## Mechanism

A running process cannot overwrite its own live binary, so the swap is handed to a **detached
helper script** that outlives the process:

1. **`POST /api/update/install`** (CSRF-guarded via `sameOriginLocal`, like `/api/quit`):
   - Re-check the latest release to get this platform's asset URL.
   - Download the asset to a unique staging dir under the OS temp dir.
   - macOS: unzip (`ditto -x -k`) → locate `*.app`; verify `Contents/MacOS/trade-review` exists.
     Windows: the asset is the bare `.exe`; verify it downloaded and is a plausible size (> 1 MB, so
     a truncated/HTML error body is rejected).
   - Write a platform-specific **swap script** to the staging dir and spawn it **detached**
     (`detached: true`, `stdio: "ignore"`, `.unref()`).
   - Return `202 {installing:true}`, then gracefully shut down (reuse the existing `quit()` — the 202
     flushes first).
   - Any failure before the spawn returns `500 {error}` and the app keeps running (no shutdown).

2. **Swap script** (waits for this process to exit, then swaps + relaunches):
   - **macOS** (`sh`): wait until `kill -0 <pid>` fails → `mv` the old `.app` aside, `mv` the new one
     into place (roll back on failure), `touch` the silent-relaunch marker, `open` the `.app`
     (relaunch via LaunchServices so the Dock icon is preserved), clean up staging + self.
   - **Windows** (`.cmd`): retry `move /y new.exe target.exe` until it succeeds (the move is blocked
     until the running exe releases its lock on exit — a natural wait), create the marker, `start`
     the exe, clean up staging + self.

3. **Silent single-tab relaunch.** The relaunched process must not open a second browser tab. The
   swap script drops a one-shot marker file (`<dataDir>/.reopen-silent`) immediately before
   relaunching; `app.ts` startup treats the marker like `NO_OPEN=1` for that launch and deletes it.
   Meanwhile the frontend keeps its existing tab, polls for the new server, and reloads itself.

## Frontend

- `UpdateStatus` gains `canInstall: boolean` (true only when compiled + supported platform + an asset
  for this platform exists).
- Banner: when `canInstall`, the primary button is **Update & Restart** instead of Download.
  Clicking it:
  1. `POST /api/update/install`; on 202 show an "Updating… the app will reopen automatically"
     overlay/state (button disabled, spinner).
  2. Poll `GET /api/version` (new, cheap, local: `{version}`) every ~1.5 s. Before the restart it
     returns the old version; during the restart the fetch fails (ignored); once it returns
     `version === latest`, `location.reload()`.
  3. On a `500` from install, show the error inline and re-enable the button.
- When `!canInstall`, the banner is unchanged (Download / View release / What's new).

## New / changed backend surface

- `src/api/update.ts`: add `canInstall` to `UpdateStatus`; `buildUpdateStatus` / `checkForUpdate`
  take an `installSupported` flag (default false) → `canInstall = installSupported && asset present`.
- `src/api/self-update.ts` (new):
  - `installTargetFor(platform, execPath)` → `{kind:"macapp", appDir} | {kind:"winexe", exePath} | null`
    (pure; testable — parses the `.app` root three dirs up from the mac exec path).
  - `macSwapScript(...)` / `winSwapScript(...)` → script strings (pure; testable).
  - `performInstall(opts)` → orchestrates download/unzip/verify/spawn (thin I/O; not unit-tested).
- `src/api/routes.ts`: `POST /api/update/install` and `GET /api/version`; `ApiDeps` gains
  `installUpdate?` and `appVersion?`.
- `src/app.ts`: wire `installUpdate` (calls `performInstall` then `quit()`), pass `appVersion`, and
  honor the `.reopen-silent` marker at startup.

## Build change

- `scripts/build.ts`: remove the `LSUIElement` plist key and its comment block. The app returns to a
  normal foreground app with a Dock icon.

## Testing

- Unit (pure helpers): `installTargetFor` (mac path parse, windows, source/linux → null),
  `canInstall` via `buildUpdateStatus`/`checkForUpdate` (installSupported flag interplay with asset
  presence), and the two script generators (contain the pid/paths/marker/relaunch commands).
- Update the three existing `buildUpdateStatus` full-shape `toEqual` tests to include
  `canInstall: false`.
- Gates: `bun test`, `bunx tsc --noEmit`.
- Manual verification: build the current target, confirm `canInstall` reflects compiled vs source,
  and dry-run the generated swap script logic. (A full download→swap→relaunch round trip needs a real
  newer GitHub release, so it's verified by inspection + a scripted swap against a dummy bundle.)
