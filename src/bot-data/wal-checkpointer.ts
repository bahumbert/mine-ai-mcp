// Runs WAL checkpoints of one bot-data file on a worker thread, so SQLite never checkpoints inside the bot connection's COMMIT.
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

/** How often the worker copies WAL frames into the database file. */
export const WAL_CHECKPOINT_INTERVAL_MS = 2_000;
/** The WAL file is cut back to this size each time it resets after a complete checkpoint. */
export const WAL_JOURNAL_SIZE_LIMIT_BYTES = 64 * 1024 * 1024;
/** Disposing waits this long, on the wall clock, for the worker to close its connection; then it is terminated. */
const STOP_WAIT_MS = 1_000;

export interface WalCheckpointerOptions {
  readonly intervalMs?: number;
  /** Called once when the worker died on its own (never after dispose); the store then checkpoints automatically again. */
  readonly fellBack: (cause: string) => void;
}

export interface WalCheckpointerWorkerData {
  readonly file: string;
  readonly intervalMs: number;
  /** One Int32 the worker sets to 1 once its connection is closed (or never opened), then notifies. */
  readonly released: SharedArrayBuffer;
}

/** What the worker tells the main thread; a failed cycle is retried at the next interval. */
export interface WalCheckpointerMessage {
  readonly kind: "checkpoint-failed";
  readonly message: string;
}

/**
 * Runs `PRAGMA wal_checkpoint(PASSIVE)` of one database file on a worker thread, so SQLite's automatic checkpoint
 * (about 4 MB of frames copied inside the writer's COMMIT, 100-250 ms on the event loop) never runs on the bot's
 * thread. PASSIVE takes no writer lock: the bot connection's writes are never refused because of it.
 */
export function startWalCheckpointer(file: string, options: WalCheckpointerOptions): Disposable {
  const intervalMs = options.intervalMs ?? WAL_CHECKPOINT_INTERVAL_MS;
  const workerFile = new URL(import.meta.url.endsWith(".ts") ? "./wal-checkpoint-worker.ts" : "./wal-checkpoint-worker.js", import.meta.url);
  const released = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  const data: WalCheckpointerWorkerData = { file, intervalMs, released: released.buffer as SharedArrayBuffer };
  const worker = new Worker(fileURLToPath(workerFile), { workerData: data });
  worker.unref();
  let stopping = false;
  let fellBack = false;
  const fallBack = (cause: string): void => {
    if (stopping || fellBack) return;
    fellBack = true;
    options.fellBack(cause);
  };
  worker.on("message", (message: WalCheckpointerMessage) => {
    if (message.kind === "checkpoint-failed") process.stderr.write(`[minecraft-bot-data] WAL checkpoint failed (${message.message}); retrying\n`);
  });
  worker.on("error", (error) => fallBack(error instanceof Error ? error.message : String(error)));
  worker.on("exit", (code) => fallBack(`worker exited with code ${code}`));
  return {
    [Symbol.dispose]() {
      if (stopping) return;
      stopping = true;
      worker.postMessage("stop");
      // The store closes next and may be reopened or locked exclusively at once (a restart, a journal-mode change):
      // the worker's connection must be gone when this returns. The worker is another thread, so this wait is short.
      if (Atomics.wait(released, 0, 0, STOP_WAIT_MS) === "timed-out") void worker.terminate();
    },
  };
}

/**
 * One checkpoint attempt per call. An error is retried at the next call and reported when its message differs from the
 * one just reported, so a disk that stays full writes one line, not one every interval.
 */
export function createCheckpointRunner(checkpointer: { checkpoint(): void }, report: (message: string) => void): () => void {
  let lastReported: string | null = null;
  return () => {
    try {
      checkpointer.checkpoint();
      lastReported = null;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (message !== lastReported) report(message);
      lastReported = message;
    }
  };
}
