import { useState } from "react";
import { useUpdateCheck } from "../lib/hooks";
import { api } from "../lib/api";

const DISMISS_KEY = "dismissedUpdateVersion";

/** Poll GET /api/version until it reports `target` (the new build), then reload the page. During the
 * swap the server is briefly down, so failed fetches are ignored. Gives up after a generous cap so a
 * botched relaunch doesn't spin forever. */
async function waitForRelaunch(target: string, capMs = 120_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < capMs) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const { version } = await api.version();
      if (version === target) return true;
    } catch {
      /* server restarting — keep polling */
    }
  }
  return false;
}

/** A slim banner shown when a newer release exists on GitHub. When the app can update itself in place
 * (`canInstall`), the primary action is "Update & Restart": it downloads the new build, swaps the app
 * on disk, and relaunches — the page then reloads itself onto the new version. Otherwise it falls back
 * to a plain download link. Dismissing remembers the version so it won't nag again until a still-newer
 * release appears. Your data lives outside the app, so an update never touches it. */
export function UpdateBanner() {
  const { data } = useUpdateCheck();
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISS_KEY);
    } catch {
      return null;
    }
  });
  // idle → installing (button clicked, download+swap in flight, then relaunch poll) → error (failed).
  const [phase, setPhase] = useState<"idle" | "installing" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  if (!data || !data.updateAvailable || !data.latest) return null;
  if (dismissed === data.latest && phase === "idle") return null;

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, data.latest!);
    } catch {
      /* private mode / storage disabled — dismissal just won't persist */
    }
    setDismissed(data.latest);
  };

  const install = async () => {
    setPhase("installing");
    setErrorMsg(null);
    try {
      await api.installUpdate(); // 202 → the server begins the swap and then shuts down to relaunch
    } catch (e) {
      // A 500 (or network failure) BEFORE relaunch means the app is still running and didn't update.
      setErrorMsg(e instanceof Error ? e.message : "update failed");
      setPhase("error");
      return;
    }
    const relaunched = await waitForRelaunch(data.latest!);
    if (relaunched) {
      window.location.reload();
    } else {
      setErrorMsg("the app didn't come back — reopen it manually");
      setPhase("error");
    }
  };

  const downloadHref = data.downloadUrl ?? data.releaseUrl ?? undefined;

  return (
    <div className="update-banner" role="status">
      <span className="update-banner-dot" aria-hidden />
      <span className="update-banner-text">
        {phase === "installing" ? (
          <>Updating to <strong>{data.latest}</strong>… the app will reopen automatically</>
        ) : phase === "error" ? (
          <>Update failed<span className="faint"> · {errorMsg}</span></>
        ) : (
          <>
            Trade&nbsp;Review <strong>{data.latest}</strong> is available
            <span className="faint"> · you have {data.current}</span>
          </>
        )}
      </span>

      {phase === "installing" ? (
        <span className="update-banner-link" aria-live="polite">Working…</span>
      ) : data.canInstall ? (
        <>
          <button className="btn btn-primary btn-sm" onClick={install}>
            {phase === "error" ? "Retry" : "Update & Restart"}
          </button>
          {data.releaseUrl && (
            <a className="update-banner-link" href={data.releaseUrl} target="_blank" rel="noopener noreferrer">
              What's new
            </a>
          )}
        </>
      ) : (
        <>
          {downloadHref && (
            <a className="btn btn-primary btn-sm" href={downloadHref} target="_blank" rel="noopener noreferrer">
              {data.downloadUrl ? "Download" : "View release"}
            </a>
          )}
          {data.downloadUrl && data.releaseUrl && (
            <a className="update-banner-link" href={data.releaseUrl} target="_blank" rel="noopener noreferrer">
              What's new
            </a>
          )}
        </>
      )}

      {phase !== "installing" && (
        <button className="update-banner-close" onClick={dismiss} title="Dismiss" aria-label="Dismiss update notice">
          ✕
        </button>
      )}
    </div>
  );
}
