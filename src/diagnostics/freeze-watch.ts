import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";

/**
 * A freeze record, written from a worker thread while the main thread is wedged.
 * The supervisor kills a silent runtime with SIGKILL, which leaves nothing but what already crossed IPC; a worker
 * reads the shared state itself and writes its file synchronously, because its postMessage only arrives after the
 * main thread unblocks.
 */
export const MARKER_SLOTS = 64;
/** Slot: seq i32 @0, length i32 @4, time f64 @8, text @16, repeat count i32 @156. */
export const MARKER_BYTES = 140;
export const REPEATS_INDEX = 39;
export const HEADER_BYTES = 64;
export const SLOT_BYTES = 160;

export interface FreezeWatchWorkerData {
  readonly shared: SharedArrayBuffer;
  readonly dir: string;
  readonly botName: string;
  readonly stallMs: number;
}

export interface FreezeWatchOptions {
  readonly dir: string;
  readonly botName: string;
  readonly stallMs?: number;
}

export interface FreezeWatch extends Disposable {
  /** Path of the newest freeze record this watch has seen written, if any. */
  lastRecord(): string | null;
}

let active: { head: Int32Array; slots: Int32Array; times: Float64Array; text: Uint8Array } | null = null;
let lastText: string | null = null;
const encoder = new TextEncoder();

/** Layout views over the shared buffer, used by both threads: header = [next seq (i32), -, lastBump (f64 @8)]. */
export function freezeViews(shared: SharedArrayBuffer) {
  return {
    head: new Int32Array(shared, 0, 2),
    bump: new Float64Array(shared, 8, 1),
    slots: new Int32Array(shared, HEADER_BYTES, (MARKER_SLOTS * SLOT_BYTES) / 4),
    times: new Float64Array(shared, HEADER_BYTES, (MARKER_SLOTS * SLOT_BYTES) / 8),
    text: new Uint8Array(shared, HEADER_BYTES, MARKER_SLOTS * SLOT_BYTES),
  };
}

/**
 * Cheap main-thread breadcrumb: the newest 64 are kept. A marker equal to the previous one takes no new slot (a
 * per-tick marker would push everything else out of the ring); it refreshes that slot's time and repeat count.
 * A no-op until a watch is running.
 */
export function markPhase(text: string): void {
  if (!active) return;
  const sequence = Atomics.load(active.head, 0);
  if (sequence > 0 && text === lastText) {
    const previous = (sequence - 1) % MARKER_SLOTS;
    active.times[previous * (SLOT_BYTES / 8) + 1] = Date.now();
    active.slots[previous * (SLOT_BYTES / 4) + REPEATS_INDEX]!++;
    return;
  }
  lastText = text;
  const slot = sequence % MARKER_SLOTS;
  const bytes = active.text.subarray(slot * SLOT_BYTES + 16, slot * SLOT_BYTES + 16 + MARKER_BYTES);
  const { written } = encoder.encodeInto(text, bytes);
  active.slots[slot * (SLOT_BYTES / 4) + 1] = written;
  active.slots[slot * (SLOT_BYTES / 4) + REPEATS_INDEX] = 1;
  active.times[slot * (SLOT_BYTES / 8) + 1] = Date.now();
  Atomics.store(active.slots, slot * (SLOT_BYTES / 4), sequence + 1);
  Atomics.store(active.head, 0, sequence + 1);
}

export function startFreezeWatch({ dir, botName, stallMs = 3000 }: FreezeWatchOptions): FreezeWatch {
  const shared = new SharedArrayBuffer(HEADER_BYTES + MARKER_SLOTS * SLOT_BYTES);
  const views = freezeViews(shared);
  active = views;
  lastText = null;
  views.bump[0] = Date.now();
  const workerFile = new URL(
    import.meta.url.endsWith(".ts") ? "./freeze-watch-worker.ts" : "./freeze-watch-worker.js",
    import.meta.url,
  );
  const data: FreezeWatchWorkerData = { shared, dir, botName, stallMs };
  const worker = new Worker(fileURLToPath(workerFile), { workerData: data });
  let last: string | null = null;
  worker.on("message", (message: { file: string }) => {
    last = message.file;
    process.stderr.write(
      `[mine-ai-mcp] freeze recovered after ${Math.round(Date.now() - views.bump[0]!)} ms (record: ${message.file})\n`,
    );
  });
  worker.on("error", (cause) => process.stderr.write(`[mine-ai-mcp] freeze watch worker failed: ${cause}\n`));
  worker.unref();
  const beat = setInterval(() => {
    views.bump[0] = Date.now();
  }, 100);
  beat.unref();
  return {
    lastRecord: () => last,
    [Symbol.dispose]() {
      clearInterval(beat);
      void worker.terminate();
      if (active === views) active = null;
    },
  };
}
