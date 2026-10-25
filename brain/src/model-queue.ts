import { renameSync, writeFileSync } from "node:fs";
import type { ChatModel, ChatReply, ChatTurn } from "./chat-model.ts";

/** Where the brain tells the monitor how busy the model is, next to the bots' folders (monitor "Model queue" panel). */
export const MODEL_QUEUE_FILE = "brain-model-queue.json";

const WRITE_INTERVAL_MS = 500;
const HISTORY_WINDOW_MS = 60 * 60_000;
const MAX_HISTORY_SAMPLES = 4_000;

/** What the file holds; times are epoch milliseconds. */
export interface QueueSnapshot {
  readonly at: number;
  readonly slots: number | null;
  readonly inFlight: number;
  readonly waiting: number;
  readonly byAgent: Readonly<Record<string, number>>;
  readonly history: readonly { readonly at: number; readonly inFlight: number }[];
  readonly starts: readonly { readonly id: string; readonly at: number }[];
}

export interface ModelQueueOptions {
  /** How many calls the model server runs at once (Ollama's OLLAMA_NUM_PARALLEL); null when unknown. */
  readonly slots: number | null;
  /** Where to write {@link QueueSnapshot}; null writes nothing. */
  readonly file: string | null;
  readonly now?: () => number;
  /** Told once when the file cannot be written (and again after a write worked in between). */
  readonly log?: (line: string) => void;
}

/**
 * Counts the model calls in flight across every agent of the brain process. The model server queues what exceeds its
 * parallel slots and has no endpoint to say so (run 5, 2026-10-10: twelve bots started at once, each first goal call
 * waited 29-66 s behind three slots), so only the brain can tell how many calls wait.
 */
export class ModelQueue {
  private readonly slots: number | null;
  private readonly file: string | null;
  private readonly now: () => number;
  private readonly byAgent = new Map<string, number>();
  private readonly history: { at: number; inFlight: number }[] = [];
  private readonly starts: { id: string; at: number }[] = [];
  private readonly freed: (() => void)[] = [];
  /** Calls asked and not finished (running + held). */
  private count = 0;
  /** Calls that own a slot. */
  private running = 0;
  /** Calls waiting for a slot, first asked first. */
  private readonly held: (() => void)[] = [];
  private lastWrite = Number.NEGATIVE_INFINITY;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writeFailed = false;
  private readonly log: ((line: string) => void) | undefined;

  constructor(options: ModelQueueOptions) {
    this.log = options.log;
    this.slots = options.slots;
    this.file = options.file;
    this.now = options.now ?? Date.now;
  }

  /**
   * The same model, every call counted for the agent from the moment it is asked. With known slots a call takes one
   * before `model.complete` runs, so the model client's own timeout times inference, not the line, and gives it back
   * when the call ends or fails; beyond the slots it waits here, first asked first served, until its signal aborts.
   */
  track(model: ChatModel, agentId: string): ChatModel {
    return {
      name: model.name,
      complete: async (turns: readonly ChatTurn[], signal: AbortSignal): Promise<ChatReply> => {
        this.change(agentId, 1);
        try {
          const held = this.takeSlot(signal);
          if (held !== null) await held;
          try {
            return await model.complete(turns, signal);
          } finally {
            this.giveSlotBack();
          }
        } finally {
          this.change(agentId, -1);
        }
      },
    };
  }

  /** Calls asked and not finished: running plus held. */
  inFlight(): number {
    return this.count;
  }

  /** Calls held here for a slot. */
  waiting(): number {
    return this.held.length;
  }

  free(): boolean {
    return this.slots === null || this.count < this.slots;
  }

  /** Resolves once a slot is free (at once if one is); rejects when `signal` aborts. */
  whenFree(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.free()) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const onFree = (): void => {
        if (!this.free()) return;
        cleanup();
        resolve();
      };
      const onAbort = (): void => {
        cleanup();
        reject(signal.reason);
      };
      const cleanup = (): void => {
        signal.removeEventListener("abort", onAbort);
        const index = this.freed.indexOf(onFree);
        if (index >= 0) this.freed.splice(index, 1);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.freed.push(onFree);
    });
  }

  /** Records that an agent started, for the monitor's tick on the graph. */
  started(agentId: string): void {
    const at = this.now();
    this.starts.push({ id: agentId, at });
    this.prune(at);
    this.changed();
  }

  /** Writes the file now, whatever the interval. */
  flush(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.write();
  }

  /** Null when the call owns a slot already (slots unknown or one free: the model is asked in the same tick); else resolves once it does, rejects with `signal.reason`. */
  private takeSlot(signal: AbortSignal): Promise<void> | null {
    if (this.slots === null) return null;
    if (this.running < this.slots && this.held.length === 0) {
      this.running += 1;
      return null;
    }
    signal.throwIfAborted();
    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        this.held.splice(this.held.indexOf(waiter), 1);
        reject(signal.reason);
      };
      // The slot is handed over still counted as running, so a woken call never races a new one for it.
      const waiter = (): void => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.held.push(waiter);
    });
  }

  private giveSlotBack(): void {
    if (this.slots === null) return;
    const next = this.held.shift();
    if (next === undefined) this.running -= 1;
    else next();
  }

  private change(agentId: string, by: 1 | -1): void {
    this.count += by;
    const mine = (this.byAgent.get(agentId) ?? 0) + by;
    if (mine > 0) this.byAgent.set(agentId, mine);
    else this.byAgent.delete(agentId);
    const at = this.now();
    this.history.push({ at, inFlight: this.count });
    this.prune(at);
    if (by < 0) for (const onFree of [...this.freed]) onFree();
    this.changed();
  }

  private prune(at: number): void {
    const oldest = at - HISTORY_WINDOW_MS;
    while (this.history.length > 0 && (this.history[0]!.at < oldest || this.history.length > MAX_HISTORY_SAMPLES)) this.history.shift();
    while (this.starts.length > 0 && this.starts[0]!.at < oldest) this.starts.shift();
  }

  /** At most one write per interval, the last change always following in a trailing write. */
  private changed(): void {
    if (this.file === null || this.timer !== null) return;
    const wait = WRITE_INTERVAL_MS - (this.now() - this.lastWrite);
    if (wait <= 0) {
      this.write();
      return;
    }
    this.timer = setTimeout(() => this.flush(), wait);
    this.timer.unref();
  }

  private write(): void {
    if (this.file === null) return;
    const at = this.now();
    this.lastWrite = at;
    const snapshot: QueueSnapshot = {
      at,
      slots: this.slots,
      inFlight: this.count,
      waiting: this.waiting(),
      byAgent: Object.fromEntries(this.byAgent),
      history: this.history,
      starts: this.starts,
    };
    // Whole file or nothing: the monitor reads it while the brain writes.
    // On a shared drive the rename can be refused (EPERM/EBUSY): the monitor's graph is not worth a failed model call or
    // a dead timer, so the failure is logged once and the next write tries again.
    try {
      writeFileSync(`${this.file}.tmp`, JSON.stringify(snapshot));
      renameSync(`${this.file}.tmp`, this.file);
    } catch (error) {
      if (!this.writeFailed) this.log?.(`model queue file not written, retrying at the next change: ${String(error)}`);
      this.writeFailed = true;
      return;
    }
    this.writeFailed = false;
  }
}

export interface StaggerOptions {
  /** Least time between one start and the next; 0 starts them all at once. */
  readonly gapMs: number;
  /** Also wait until a model slot is free before each start after the first; null does not wait for the queue. */
  readonly whenFree: ((signal: AbortSignal) => Promise<void>) | null;
  readonly signal: AbortSignal;
  readonly now?: () => number;
  /** Replaced in tests. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Starts the agents in order: the first at once, each next after `gapMs` from the previous start and, when asked, once
 * the model queue has a free slot (both). `start` gets the time since the previous start (null for the first). A
 * shutdown while waiting stops the rest quietly.
 */
export async function startStaggered<T>(
  agents: readonly T[],
  start: (agent: T, afterMs: number | null) => void,
  options: StaggerOptions,
): Promise<void> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? abortableSleep;
  let previous: number | null = null;
  try {
    for (const agent of agents) {
      if (previous !== null) {
        const remaining = options.gapMs - (now() - previous);
        if (remaining > 0) await sleep(remaining, options.signal);
        if (options.whenFree !== null) await options.whenFree(options.signal);
      }
      const at = now();
      start(agent, previous === null ? null : at - previous);
      previous = at;
    }
  } catch (error) {
    if (!options.signal.aborted) throw error;
  }
}
