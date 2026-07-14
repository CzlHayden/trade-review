#!/usr/bin/env bun
// Build a single-file Trade Review binary for one target. Used both locally and by CI (one call per
// native runner). `bun build --compile` embeds the Bun runtime + the bundled React SPA, so the output
// is a standalone executable with no install step for the end user.
//
//   bun run scripts/build.ts [target]
//
// target ∈ current | windows-x64 | darwin-arm64 | darwin-x64 | linux-x64   (default: current)
//
// Notes:
//  - The Windows console is hidden with --windows-hide-console, which Bun only honours when the build
//    RUNS on Windows. So the release workflow builds the windows target on a windows-latest runner;
//    a cross-compiled windows binary from macOS/Linux still works but shows a console window.
//  - Windows executable metadata (title/publisher/version/icon) is set here so the .exe isn't an
//    anonymous blob to SmartScreen / Task Manager.
//  - For macOS targets we also wrap the binary in a double-clickable `Trade Review.app`.
import { mkdirSync, writeFileSync, rmSync, chmodSync, copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import pkg from "../package.json";

const VERSION = (pkg as { version?: string }).version ?? "0.0.0";
const APP_NAME = "Trade Review";
const BUNDLE_ID = "com.tradereview.app";

type Os = "windows" | "darwin" | "linux";
interface TargetSpec {
  bunTarget: string; // --target value
  os: Os;
  outName: string; // file name inside dist/
}

function resolveTarget(arg: string): TargetSpec {
  switch (arg) {
    case "windows-x64":
      return { bunTarget: "bun-windows-x64", os: "windows", outName: "trade-review-windows-x64.exe" };
    case "darwin-arm64":
      return { bunTarget: "bun-darwin-arm64", os: "darwin", outName: "trade-review-macos-arm64" };
    case "darwin-x64":
      return { bunTarget: "bun-darwin-x64", os: "darwin", outName: "trade-review-macos-x64" };
    case "linux-x64":
      return { bunTarget: "bun-linux-x64", os: "linux", outName: "trade-review-linux-x64" };
    case "current": {
      // Build for the host platform (no cross-compile) — the fast path for local testing.
      const os: Os = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux";
      const ext = os === "windows" ? ".exe" : "";
      return { bunTarget: `bun-${process.platform === "win32" ? "windows" : process.platform}-${process.arch === "arm64" ? "arm64" : "x64"}`, os, outName: `trade-review-current${ext}` };
    }
    default:
      throw new Error(`unknown target "${arg}" (want current|windows-x64|darwin-arm64|darwin-x64|linux-x64)`);
  }
}

/** Wrap a built macOS binary in a minimal double-clickable .app bundle (opens with no Terminal).
 * `appParent` is arch-scoped so building both mac targets on one machine doesn't clobber a single
 * shared bundle (the .app inside keeps its user-facing name for zipping). */
function makeMacApp(appParent: string, binaryPath: string): string {
  const appDir = join(appParent, `${APP_NAME}.app`);
  const macOsDir = join(appDir, "Contents", "MacOS");
  const resDir = join(appDir, "Contents", "Resources");
  rmSync(appDir, { recursive: true, force: true });
  mkdirSync(macOsDir, { recursive: true });
  mkdirSync(resDir, { recursive: true });
  const exeName = "trade-review";
  copyFileSync(binaryPath, join(macOsDir, exeName));
  chmodSync(join(macOsDir, exeName), 0o755);
  // App icon: bundle assets/AppIcon.icns (regenerate with scripts/make-icon.py). CFBundleIconFile is
  // the base name, no extension. Skip gracefully if the .icns is missing (falls back to a blank icon).
  const iconSrc = join(import.meta.dir, "..", "assets", "AppIcon.icns");
  const hasIcon = existsSync(iconSrc);
  if (hasIcon) copyFileSync(iconSrc, join(resDir, "AppIcon.icns"));
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${APP_NAME}</string>
  <key>CFBundleDisplayName</key><string>${APP_NAME}</string>
  <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
  <key>CFBundleVersion</key><string>${VERSION}</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleExecutable</key><string>${exeName}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>${hasIcon ? `\n  <key>CFBundleIconFile</key><string>AppIcon</string>` : ""}
</dict>
</plist>
`;
  writeFileSync(join(appDir, "Contents", "Info.plist"), plist);
  return appDir;
}

/** Re-sign the .app with a valid ad-hoc signature. Bun's `--compile` emits a "linker-signed" ad-hoc
 * signature that does NOT seal the payload it appends after the Mach-O, so `codesign --verify` reports
 * "code or signature have been modified" — and a DOWNLOADED (quarantined) copy then shows the dead-end
 * "\"Trade Review\" is damaged and can't be opened" dialog instead of the normal, recoverable
 * "unidentified developer → Open Anyway" flow. A plain `codesign --sign -` reseals the whole bundle,
 * which fixes the "damaged" message. It stays UNNOTARIZED (removing the warning entirely needs a paid
 * Apple Developer ID), so users still Open Anyway once — as the README describes. codesign is macOS-only,
 * so this is a warn-and-skip no-op when cross-building a darwin target from another OS. */
function codesignMacApp(appDir: string): void {
  if (process.platform !== "darwin") {
    console.warn(`⚠ host is ${process.platform}, not macOS — leaving the .app unsigned (codesign unavailable)`);
    return;
  }
  const sign = Bun.spawnSync(["codesign", "--force", "--deep", "--sign", "-", appDir], { stdout: "inherit", stderr: "inherit" });
  if (!sign.success) throw new Error("codesign failed — the .app would ship with Bun's invalid signature");
  const verify = Bun.spawnSync(["codesign", "--verify", "--verbose", appDir], { stdout: "inherit", stderr: "inherit" });
  if (!verify.success) throw new Error("codesign --verify failed after signing");
}

async function main() {
  const arg = process.argv[2] ?? "current";
  const spec = resolveTarget(arg);
  const distDir = join(import.meta.dir, "..", "dist");
  mkdirSync(distDir, { recursive: true });
  const outPath = join(distDir, spec.outName);

  // Absolute entry path so the script works regardless of the caller's cwd (e.g. CI).
  const entry = join(import.meta.dir, "..", "src", "app.ts");
  const args = ["build", entry, "--compile", `--target=${spec.bunTarget}`, `--outfile=${outPath}`];
  // The Windows console-hiding AND the executable-metadata flags are ALL only accepted when the build
  // runs on Windows (Bun rejects them when cross-compiling). So the release workflow builds the
  // windows target on a windows-latest runner; a cross-compiled .exe from macOS/Linux is a plain,
  // console-showing binary — fine for local testing.
  if (spec.os === "windows" && process.platform === "win32") {
    args.push(
      "--windows-hide-console",
      `--windows-title=${APP_NAME}`,
      `--windows-publisher=Trade Review`,
      `--windows-version=${VERSION}.0`,
      `--windows-description=${APP_NAME}`,
    );
  }

  console.log(`Building ${APP_NAME} v${VERSION} → dist/${spec.outName} (${spec.bunTarget})`);
  const proc = Bun.spawnSync(["bun", ...args], { stdout: "inherit", stderr: "inherit" });
  if (!proc.success) throw new Error("bun build failed");

  // Bun appends .exe for windows targets even if the outfile lacked it; normalise the message.
  const built = existsSync(outPath) ? outPath : `${outPath}.exe`;
  console.log(`✓ ${built}`);

  if (spec.os === "darwin") {
    // Arch-scoped parent dir so `build darwin-arm64` and `build darwin-x64` don't overwrite one
    // another's bundle. e.g. dist/app-macos-arm64/Trade Review.app (no collision with the raw binary).
    const appParent = join(distDir, `app-${spec.outName.replace(/^trade-review-/, "")}`);
    mkdirSync(appParent, { recursive: true });
    const app = makeMacApp(appParent, built);
    codesignMacApp(app);
    console.log(`✓ ${app}`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
