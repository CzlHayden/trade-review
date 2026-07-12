import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

export type ToastKind = "ok" | "err";

export interface ToastData {
  id: number;
  kind: ToastKind;
  title: string;
  body?: string;
}

/** A single auto-dismissing notification. Pauses its countdown on hover so a message can be read.
 * Styled with the app tokens (coloured left rail = outcome), positioned by ToastHost. */
function Toast({ toast, onDismiss }: { toast: ToastData; onDismiss: (id: number) => void }) {
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (paused) return;
    const t = setTimeout(() => onDismiss(toast.id), 6000);
    return () => clearTimeout(t);
  }, [paused, toast.id, onDismiss]);

  return (
    <div
      className={`toast ${toast.kind}`}
      role="status"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <span className="toast-ico" aria-hidden>
        {toast.kind === "ok" ? "✓" : "!"}
      </span>
      <div className="toast-text">
        <div className="toast-title">{toast.title}</div>
        {toast.body && <div className="toast-body">{toast.body}</div>}
      </div>
      <button className="toast-close" aria-label="Dismiss" onClick={() => onDismiss(toast.id)}>
        ×
      </button>
    </div>
  );
}

/** Fixed-position stack of toasts (newest at the bottom, nearest the corner). Portalled to <body>
 * so it is NOT contained by a filtered/transformed ancestor (the topbar has backdrop-filter, which
 * would otherwise become the containing block for `position: fixed` and anchor toasts to the header). */
export function ToastHost({ toasts, onDismiss }: { toasts: ToastData[]; onDismiss: (id: number) => void }) {
  if (toasts.length === 0) return null;
  return createPortal(
    <div className="toast-host">
      {toasts.map((t) => (
        <Toast key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>,
    document.body,
  );
}
