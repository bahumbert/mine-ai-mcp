import { renameSync, writeFileSync } from "node:fs";
import type { ChatModel, ChatReply, ChatTurn, CompleteOptions, ModelLane } from "./chat-model.ts";
import { chatSlotsRefusal } from "./model-lanes.ts";
import { monotonicNow } from "./monotonic-clock.ts";
import { timeoutSignal } from "./wall-timers.ts";

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
  /** Slots kept for the chat lane (0: none), and the calls of that lane running and held. */
  readonly chatSlots: number;
  readonly chatInFlight: number;
  readonly chatWaiting: number;
  readonly byAgent: Readonly<Record<string, number>>;
  readonly history: readonly { readonly at: number; readonly inFlight: number }[];
  readonly starts: readonly { readonly id: string; readonly at: number }[];
}

export interface ModelQueueOptions {
  /** How many calls the model server runs at once (Ollama's OLLAMA_NUM_PARALLEL); null when unknown. */
  readonly slots: number | null;
  /**
   * How many of the slots only the chat lane may use (default 0): whole number, below `slots`, and 0 when the slots are
   * unknown. Refused with `[BAD_CHAT_SLOTS]` otherwise.
   */
  readonly chatSlots?: number;
  /** Where to write {@link QueueSnapshot}; null writes nothing. */
  readonly file: string | null;
  readonly now?: () => number;
  /** Told once when the file cannot be written (and again after a write worked in between). */
  readonly log?: (line: string) => void;
}

/** A call held for a slot; lower priority goes first, then the earlier arrival. */
interface Waiter {
  readonly lane: ModelLane;
  readonly priority: number;
  readonly arrival: number;
  readonly agentId: string;
  readonly grant: () => void;
}

/**
 * Counts the model calls in flight across every agent of the brain process, and with the slots known holds the calls
 * beyond them itself, the chat tier first (conv5, 2026-10-18: Ollama served its queue in its own order and a player's
 * line waited 28 s behind the bots' work; run 5, 2026-10-10: twelve bots at once waited 29-66 s behind three slots).
 *
 * Two lanes (spec 2026-11-18 D1): of `slots`, `chatSlots` are kept for `chat` calls (the chat tier's replies to a
 * person's line); `shared` calls (every other tier) run only while fewer than `slots - chatSlots` of them run, and a
 * `chat` call may also use any idle slot. One held list, granted by priority then arrival, a waiter whose lane is
 * full being passed over. Without `chatSlots` every call is in the same lane and nothing changes.
 */
export class ModelQueue {
  private readonly slots: number | null;
  private readonly chatSlots: number;
  private chatCount = 0;
  private sharedCount = 0;
  private readonly file: string | null;
  private readonly now: () => number;
  private readonly byAgent = new Map<string, number>();
  private readonly history: { at: number; inFlight: number }[] = [];
  private readonly starts: { id: string; at: number }[] = [];
  private readonly freed: (() => void)[] = [];
  private readonly held: Waiter[] = [];
  private arrivals = 0;
  private count = 0;
  private lastWrite = Number.NEGATIVE_INFINITY;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writeFailed = false;
  private readonly log: ((line: string) => void) | undefined;

  constructor(options: ModelQueueOptions) {
    this.log = options.log;
    this.slots = options.slots;
    this.chatSlots = options.chatSlots ?? 0;
    const refusal = chatSlotsRefusal(this.slots, this.chatSlots);
    if (refusal !== null) throw new Error(`[BAD_CHAT_SLOTS] ${refusal}`);
    this.file = options.file;
    this.now = options.now ?? Date.now;
  }

  /** The same model, every call counted for the agent while it runs. */
  track(model: ChatModel, agentId: string): ChatModel {
    return {
      name: model.name,
      complete: async (turns: readonly ChatTurn[], signal: AbortSignal, options?: CompleteOptions): Promise<ChatReply> => {
        const asked = this.now();
        const lane = options?.lane ?? "shared";
        // A free slot is taken without yielding, so the model starts in the same tick as before the gate existed.
        const held = this.takeSlot(agentId, signal, options?.priority ?? 0, lane);
        if (held !== null) await held;
        const waitMs = this.now() - asked;
        try {
          return { ...(await model.complete(turns, signal, options)), waitMs };
        } finally {
          this.change(agentId, -1, lane);
        }
      },
    };
  }

  /** Whether a call of `lane` may run now: slots unknown, or one is idle and (for a shared call) the shared lane is not full. */
  private canRun(lane: ModelLane): boolean {
    if (this.slots === null) return true;
    return this.count < this.slots && (lane === "chat" || this.sharedCount < this.slots - this.chatSlots);
  }

  /** Takes a slot at once (null) when one is free, else waits for it by priority; rejects with the signal's reason on abort. */
  private takeSlot(agentId: string, signal: AbortSignal, priority: number, lane: ModelLane): Promise<void> | null {
    signal.throwIfAborted();
    // A held waiter that could run would go first, but grantFreeSlots runs at every release, so none does for long.
    if (this.canRun(lane) && !this.held.some((waiter) => this.canRun(waiter.lane))) {
      this.change(agentId, 1, lane);
      return null;
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        lane,
        priority,
        arrival: this.arrivals++,
        agentId,
        grant: () => {
          signal.removeEventListener("abort", onAbort);
          this.change(agentId, 1, lane);
          resolve();
        },
      };
      const onAbort = (): void => {
        const index = this.held.indexOf(waiter);
        if (index >= 0) this.held.splice(index, 1);
        this.changed();
        reject(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.held.push(waiter);
      this.changed();
    });
  }

  /** Lets the best waiter whose lane has room run, until none has: lowest priority, then earliest arrival. */
  private grantFreeSlots(): void {
    for (;;) {
      let best = -1;
      for (let i = 0; i < this.held.length; i += 1) {
        const a = this.held[i]!;
        if (!this.canRun(a.lane)) continue;
        const b = best < 0 ? undefined : this.held[best]!;
        if (b === undefined || a.priority < b.priority || (a.priority === b.priority && a.arrival < b.arrival)) best = i;
      }
      if (best < 0) return;
      this.held.splice(best, 1)[0]!.grant();
    }
  }

  inFlight(): number {
    return this.count;
  }

  /** Calls the brain holds for a slot. */
  waiting(): number {
    return this.held.length;
  }

  /** Whether a shared call could start now: the slots kept for chat do not count (spec 2026-11-18 D1). */
  free(): boolean {
    return this.canRun("shared");
  }

  /**
   * Whether `agentId` may start a model call that can be skipped (an opening, a gist): a free slot when the slots are
   * known, else (spec 2026-10-18 "Model use") none of its own calls in flight.
   */
  freeFor(agentId: string): boolean {
    return this.slots === null ? !this.byAgent.has(agentId) : this.free();
  }

  /** Whether `agentId` may start a skippable call within `ms`: true once a slot is free, false on time-out or abort. */
  async freeWithin(agentId: string, ms: number, signal: AbortSignal): Promise<boolean> {
    try {
      await this.whenFree(AbortSignal.any([signal, timeoutSignal(ms)]));
    } catch {
      return false;
    }
    return this.freeFor(agentId);
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

  private change(agentId: string, by: 1 | -1, lane: ModelLane): void {
    this.count += by;
    if (lane === "chat") this.chatCount += by;
    else this.sharedCount += by;
    const mine = (this.byAgent.get(agentId) ?? 0) + by;
    if (mine > 0) this.byAgent.set(agentId, mine);
    else this.byAgent.delete(agentId);
    const at = this.now();
    this.history.push({ at, inFlight: this.count });
    this.prune(at);
    if (by < 0) {
      this.grantFreeSlots();
      for (const onFree of [...this.freed]) onFree();
    }
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
      chatSlots: this.chatSlots,
      chatInFlight: this.chatCount,
      chatWaiting: this.held.filter((waiter) => waiter.lane === "chat").length,
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
  const now = options.now ?? monotonicNow;
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
