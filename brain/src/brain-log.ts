import { appendFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import type { Activity } from "./activities.ts";
import type { ActivityChance } from "./activity-draw.ts";
import type { ChatTurn } from "./chat-model.ts";
import type { Place, Route } from "./mind.ts";
import type { Opportunity } from "./opportunities.ts";
import type { ActivityTotal } from "./time-spent.ts";

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
  /** The largest prompt of the attempts, in tokens as the server counted them; null when it does not say. */
  readonly promptTokens?: number | null;
  /** The context window the model ran with; null when unknown. A prompt near it was probably cut. */
  readonly contextTokens?: number | null;
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
    /** For its own objectives: the opportunities and the last hour's time the goal tier saw when it chose this one. */
    readonly opportunities?: readonly Opportunity[];
    readonly time?: readonly ActivityTotal[];
    /** The kind of work the objective is for (spec 2026-10-09-activity-draw); null when none. */
    readonly purpose?: Activity | null;
    /** For its own objectives: the two activities drawn, and the chances of the likeliest five. */
    readonly drawn?: readonly Activity[];
    readonly chances?: readonly ActivityChance[];
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
    /** The kind of work the step was (spec 2026-10-03-specialisations-preferences); null for errands. */
    readonly activity?: Activity | null;
    /** How its time divided between activities: its walking is travelling, a phase another activity (spec 2026-10-04). */
    readonly times?: readonly { readonly activity: Activity; readonly ms: number }[];
    /** What the step's objective was for (spec 2026-10-09-activity-draw); null when none. */
    readonly purpose?: Activity | null;
  }
  | { readonly kind: "progress"; readonly objective: string; readonly fact: string; readonly asked: boolean }
  /**
   * A message the chat tier read (spec 2026-10-09-chat-handling): `lines` quick lines of one speaker joined into it;
   * `superseded`: its speaker spoke again while the model thought, so the reply was dropped unspoken.
   */
  | {
    readonly kind: "chat";
    readonly speaker: string;
    readonly text: string;
    readonly channel: "chat" | "whisper";
    readonly lines: number;
    readonly route: Route;
    readonly say: string;
    readonly superseded: boolean;
    readonly to?: readonly string[];
    /** What the chat tier read besides the route: where the request happens, whether the line starts it now. */
    readonly place?: Place;
    readonly startsNow?: boolean;
  }
  /** What it is doing now: the stack (top last), the step running, if any. */
  | { readonly kind: "state"; readonly stack: readonly StackEntry[]; readonly step: string | null }
  /** Written once when the brain starts: who the character is (the monitor's character card; the session starts here). */
  | {
    readonly kind: "persona";
    readonly name: string;
    readonly stance: string;
    readonly goal: string | null;
    readonly preferences: Readonly<Record<"loves" | "likes" | "dislikes" | "hates", Activity>> | null;
  };

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
