import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";

// klinecharts' internal ResizeObserver can emit the benign "ResizeObserver loop completed with
// undelivered notifications" error when a resize callback triggers layout within the same frame.
// Root fix: defer each observer callback to the next animation frame, which breaks that synchronous
// loop so the error is never emitted. (window.onerror alone can't stop the Bun dev overlay's own
// 'error' listener; deferring at the source does.) See w3c/csswg-drafts#5023.
const NativeResizeObserver = window.ResizeObserver;
if (typeof NativeResizeObserver === "function") {
  window.ResizeObserver = class extends NativeResizeObserver {
    #dead = false;
    constructor(callback: ResizeObserverCallback) {
      // Deferring past the native delivery loses the native guarantee that no callback fires after
      // disconnect(); a resize racing an unmount in the same frame would otherwise call a chart lib's
      // resize handler on a destroyed chart (a fresh uncaught error). Skip the deferred callback if
      // the observer was disconnected in the meantime.
      super((entries, observer) => {
        window.requestAnimationFrame(() => {
          if (!this.#dead) callback(entries, observer);
        });
      });
    }
    override disconnect(): void {
      this.#dead = true;
      super.disconnect();
    }
    override observe(...args: Parameters<ResizeObserver["observe"]>): void {
      this.#dead = false; // a disconnected observer can be reused
      super.observe(...args);
    }
  };
}

// Belt-and-suspenders in case a stray loop error still surfaces: keep it off the console and away
// from a dev error overlay. This can't reliably preempt the Bun dev client's own 'error' listener
// (registered before this module) — the rAF wrap above is the real fix; this is best-effort backup.
const isRoLoop = (msg: unknown): boolean =>
  typeof msg === "string" && msg.includes("ResizeObserver loop");
window.addEventListener(
  "error",
  (e) => {
    if (isRoLoop(e.message)) {
      e.stopImmediatePropagation();
      e.preventDefault();
    }
  },
  true,
);
const priorOnError = window.onerror;
window.onerror = function (message, ...rest) {
  if (isRoLoop(message)) return true;
  return priorOnError ? (priorOnError as OnErrorEventHandlerNonNull).call(window, message, ...rest) : false;
};

const root = document.getElementById("root");
if (root) createRoot(root).render(<StrictMode><App /></StrictMode>);
