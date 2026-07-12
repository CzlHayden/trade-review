import { Link, useLocation } from "wouter";
import type { ReactNode } from "react";
import { useSyncStatus, useStartSync, useSyncToasts, useTheme, type ThemeMode } from "../lib/hooks";
import { dateTime } from "../lib/format";
import { ToastHost } from "./Toast";

const NAV = [
  { href: "/", label: "Dashboard", icon: "M3 12h4l2-7 4 14 2-7h4" },
  { href: "/trades", label: "Trades", icon: "M3 5h14M3 10h14M3 15h9" },
  { href: "/positions", label: "Positions", icon: "M3 15l4-4 3 3 6-7" },
  { href: "/journal", label: "Weekly journal", icon: "M5 3h8l3 3v11H5zM12 3v4h4" },
];

function Icon({ d }: { d: string }) {
  return (
    <svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}

function SyncIcon() {
  // Circular-arrow refresh glyph; CSS spins it while a sync is running.
  return (
    <svg className="sync-ico" width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M16.5 5.5a7 7 0 1 0 1.2 5" />
      <path d="M17 3v4h-4" />
    </svg>
  );
}

function SyncControl() {
  const status = useSyncStatus();
  const start = useStartSync();
  const { toasts, dismiss } = useSyncToasts(status.data);
  const running = status.data?.running ?? false;
  const err = status.data?.lastError;
  const last = status.data?.finishedAt;
  const dotClass = running ? "run" : err ? "err" : "ok";
  const title = running
    ? "Sync in progress…"
    : err
      ? `Last sync failed: ${err}`
      : last
        ? `Last synced ${dateTime(last)}`
        : "Not synced yet";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span className={`status-dot ${dotClass}`} role="img" title={title} aria-label={title} />
      <button
        className={`btn sync-btn${running ? " is-running" : ""}`}
        disabled={running}
        onClick={() => start.mutate()}
        title={title}
      >
        <SyncIcon />
        {running ? "Syncing…" : "Sync now"}
      </button>
      <ToastHost toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}

function ThemeToggle() {
  const { mode, setMode } = useTheme();
  const order: ThemeMode[] = ["system", "light", "dark"];
  const next = order[(order.indexOf(mode) + 1) % order.length]!;
  const glyph = mode === "dark" ? "☾" : mode === "light" ? "☀" : "◐";
  return (
    <button className="btn btn-icon" title={`Theme: ${mode} (click for ${next})`} onClick={() => setMode(next)}>
      <span style={{ fontSize: 14, lineHeight: 1 }}>{glyph}</span>
    </button>
  );
}

export function Layout({ title, children }: { title: string; children: ReactNode }) {
  const [location] = useLocation();
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-dot" />
          Trade Review
        </div>
        {NAV.map((n) => {
          const active = n.href === "/" ? location === "/" : location.startsWith(n.href);
          return (
            <Link key={n.href} href={n.href} className={`nav-item${active ? " active" : ""}`}>
              <Icon d={n.icon} />
              {n.label}
            </Link>
          );
        })}
        <div className="nav-spacer" />
      </aside>
      <div className="main">
        <header className="topbar">
          <h1>{title}</h1>
          <div className="topbar-spacer" />
          <SyncControl />
          <ThemeToggle />
        </header>
        <div className="content">{children}</div>
      </div>
    </div>
  );
}
