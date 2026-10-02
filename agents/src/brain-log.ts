import { appendFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import type { ChatTurn } from "./chat-model.ts";

/**
 * The brain's log, read by the monitor's Mind tab (spec 2026-10-02-monitor-shows-the-mind): one JSON line per event,
 * written next to the bot's bot-data file. A new run keeps the previous run's log as `brain.prev.jsonl`; past
 * {@link MAX_BYTES} the current one becomes the previous one too, so a bot never holds more than twice that.
 */
export const BRAIN_LOG_FILE = "brain.jsonl";
export const PREVIOUS_BRAIN_LOG_FILE = "brain.prev.jsonl";
const MAX_BYTES = 20 * 1024 * 1024;

/** Which part of the mind a model call was for. */
export type MindTier = "chat" | "work" | "goal" | "narrate";

export interface ModelCall {
  readonly tier: MindTier;
  readonly model: string;
  readonly ms: number;
  /** The turns sent, repair round included. */
  readonly turns: readonly ChatTurn[];
  /** The raw replies, one per attempt. */
  readonly replies: readonly string[];
  /** The decision read from the last reply, or why none could be. */
  readonly result?: unknown;
  readonly error?: string;
}

export interface StackEntry {
  readonly text: string;
  readonly requester: string | null;
}

export type BrainEvent =
  | ({ readonly kind: "model" } & ModelCall)
  | {
    readonly kind: "objective";
    /** taken: on top now; queued: after the current one; own: from its own goal; finished: done or failed. */
    readonly event: "taken" | "queued" | "own" | "finished";
    readonly text: string;
    readonly requester: string | null;
    readonly outcome?: "done" | "failed";
    readonly detail?: string;
  }
  | {
    readonly kind: "step";
    readonly objective: string;
    readonly requester: string | null;
    readonly step: string;
    readonly input: unknown;
    readonly thought: string;
    readonly outcome: "done" | "failed" | "interrupted";
    readonly detail: string;
    readonly ms: number;
  }
  | { readonly kind: "progress"; readonly objective: string; readonly fact: string; readonly asked: boolean }
  /** What it is doing now: the stack (top last), the step running, if any. */
  | { readonly kind: "state"; readonly stack: readonly StackEntry[]; readonly step: string | null };

export class BrainLog {
  private seq = 0;
  private size = 0;

  constructor(readonly path: string, private readonly maxBytes = MAX_BYTES) {
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) renameSync(path, this.previous);
  }

  private get previous(): string {
    return `${dirname(this.path)}/${PREVIOUS_BRAIN_LOG_FILE}`;
  }

  /** Appends one event; a failed write is dropped, never thrown into the work. */
  write(event: BrainEvent, at = new Date()): void {
    this.seq += 1;
    const line = `${JSON.stringify({ seq: this.seq, at: at.toISOString(), ...event })}\n`;
    try {
      const bytes = Buffer.byteLength(line);
      if (this.size > 0 && this.size + bytes > this.maxBytes) {
        renameSync(this.path, this.previous);
        this.size = 0;
      }
      appendFileSync(this.path, line);
      this.size += bytes;
    } catch {
      // The log is for watching; the character goes on without it.
    }
  }
}
