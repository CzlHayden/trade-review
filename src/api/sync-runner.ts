// In-process sync mutex + persisted status. Single process, single user ⇒ a boolean is the correct
// concurrency primitive (no job queue, no worker threads). The running sync holds the OpenD socket
// only for its own duration; read paths never touch OpenD, so the app stays read-only-safe when a
// sync fails or OpenD is down.
import type { Database } from "bun:sqlite";
import type { SyncResult } from "../sync/sync";

const KEY = "sync_status";

interface PersistedStatus {
  finishedAt: number | null;
  lastResult: SyncResult | null;
  lastError: string | null;
}

export interface SyncStatus extends PersistedStatus {
  running: boolean;
  startedAt: number | null;
}

export class SyncRunner {
  private running = false;
  private startedAt: number | null = null;
  private idle: Promise<void> = Promise.resolve();

  constructor(
    private readonly db: Database,
    private readonly job: () => Promise<SyncResult>,
    private readonly now: () => number,
  ) {}

  private load(): PersistedStatus {
    const row = this.db.query(`SELECT value FROM config WHERE key=?`).get(KEY) as
      | { value: string }
      | null;
    if (!row) return { finishedAt: null, lastResult: null, lastError: null };
    return JSON.parse(row.value) as PersistedStatus;
  }

  private save(s: PersistedStatus): void {
    this.db.run(
      `INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      [KEY, JSON.stringify(s)],
    );
  }

  status(): SyncStatus {
    return { running: this.running, startedAt: this.startedAt, ...this.load() };
  }

  /** Start a sync if none is running. Returns false when one is already in flight (the mutex). */
  start(): boolean {
    if (this.running) return false;
    this.running = true;
    this.startedAt = this.now();
    this.idle = (async () => {
      try {
        const result = await this.job();
        this.save({ finishedAt: this.now(), lastResult: result, lastError: null });
      } catch (e) {
        this.save({
          finishedAt: this.now(),
          lastResult: this.load().lastResult, // keep the last good result; surface the new error
          lastError: e instanceof Error ? e.message : String(e),
        });
      } finally {
        this.running = false;
      }
    })();
    return true;
  }

  /** Test/shutdown hook: resolves when the in-flight job (if any) settles. */
  async whenIdle(): Promise<void> {
    await this.idle;
  }
}
