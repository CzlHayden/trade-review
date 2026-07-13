import { useState } from "react";
import { useUpdateCheck } from "../lib/hooks";

const DISMISS_KEY = "dismissedUpdateVersion";

/** A slim banner shown when a newer release exists on GitHub. Notify-only: it links the user to the
 * download / release notes — the app never replaces its own binary. Dismissing remembers the version
 * so it won't nag again until a still-newer release appears. */
export function UpdateBanner() {
  const { data } = useUpdateCheck();
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISS_KEY);
    } catch {
      return null;
    }
  });

  if (!data || !data.updateAvailable || !data.latest) return null;
  if (dismissed === data.latest) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, data.latest!);
    } catch {
      /* private mode / storage disabled — dismissal just won't persist */
    }
    setDismissed(data.latest);
  };

  const downloadHref = data.downloadUrl ?? data.releaseUrl ?? undefined;

  return (
    <div className="update-banner" role="status">
      <span className="update-banner-dot" aria-hidden />
      <span className="update-banner-text">
        Trade&nbsp;Review <strong>{data.latest}</strong> is available
        <span className="faint"> · you have {data.current}</span>
      </span>
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
      <button className="update-banner-close" onClick={dismiss} title="Dismiss" aria-label="Dismiss update notice">
        ✕
      </button>
    </div>
  );
}
