import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";

// klinecharts' internal ResizeObserver fires the benign "loop completed with undelivered
// notifications" browser warning. It is harmless and dev-only (no error overlay in the compiled
// binary); swallow it at window.onerror so it doesn't spam logs.
const priorOnError = window.onerror;
window.onerror = function (message, ...rest) {
  if (typeof message === "string" && message.includes("ResizeObserver loop")) return true;
  return priorOnError ? (priorOnError as OnErrorEventHandlerNonNull).call(window, message, ...rest) : false;
};

const root = document.getElementById("root");
if (root) createRoot(root).render(<StrictMode><App /></StrictMode>);
