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
    constructor(callback: ResizeObserverCallback) {
      super((entries, observer) => {
        window.requestAnimationFrame(() => callback(entries, observer));
      });
    }
  };
}

// Belt-and-suspenders: if a stray loop error still surfaces, keep it off the console and away from
// any dev error overlay (a window 'error' listener). Capture phase so we run before the overlay.
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
