import type { Step } from "./actions.ts";
import type { Persona } from "./persona.ts";
import type { BotSnapshot, PlayerMessage } from "./runtime-client.ts";

export interface ChatLine {
  readonly speaker: string;
  readonly text: string;
}

/**
 * Where the chat tier sends a message (ADR-008): `ignore` not meant for this agent; `talk` reply only; `stop` drop
 * what it is doing; `act` it takes on a request as a new objective (ADR-011).
 */
export const ROUTES = ["ignore", "talk", "stop", "act"] as const;
export type Route = (typeof ROUTES)[number];

/**
 * A place the agent knows because it made it (a house it built): without it, "go to the roof" had no coordinates and
 * the models invented some.
 */
export interface KnownPlace {
  /** e.g. "the small medieval house you built for Tom". */
  readonly name: string;
  /** Coordinates worth going to, e.g. "door -1204 76 803 facing north; stand on its roof at -1206 82 803". */
  readonly detail: string;
}

export interface ChatInput {
  readonly persona: Persona;
  readonly message: PlayerMessage;
  /** Recent chat around the agent, oldest first, including its own lines. */
  readonly history: readonly ChatLine[];
  readonly snapshot: BotSnapshot;
  /** What the agent is doing now, e.g. `idle` or `follow StarOr1 at 3 blocks`. */
  readonly activity: string;
  /** Places the agent knows, oldest first. */
  readonly places: readonly KnownPlace[];
}

export interface ChatDecision {
  /** In-character reply spoken right away; empty means stay silent. */
  readonly say: string;
  readonly route: Route;
  /** For `act`: the request restated so it stands alone, e.g. "give Steve 5 oak logs". */
  readonly request: string;
}

/** Something the agent works towards: an order from someone, or a step of its own goal (`requester` null). */
export interface Objective {
  readonly text: string;
  readonly requester: string | null;
}

/** One step already taken for the current objective, as the work tier sees it. */
export interface StepRecord {
  readonly step: string;
  readonly outcome: "done" | "failed" | "interrupted";
  readonly detail: string;
}

export interface WorkInput {
  readonly persona: Persona;
  readonly objective: Objective;
  readonly snapshot: BotSnapshot;
  readonly places: readonly KnownPlace[];
  /** Steps taken for this objective, oldest first (the last few). */
  readonly steps: readonly StepRecord[];
  /** Objectives set aside for this one, to resume afterwards. */
  readonly paused: readonly Objective[];
}

/** The work tier's answer: the next step, or the objective is over. */
export type WorkDecision =
  | { readonly kind: "step"; readonly step: Step; readonly thought: string }
  | { readonly kind: "done"; readonly summary: string }
  /** Impossible, unclear, or it does not know how: the character says why. */
  | { readonly kind: "give_up"; readonly reason: string };

export interface GoalInput {
  readonly persona: Persona;
  readonly snapshot: BotSnapshot;
  readonly places: readonly KnownPlace[];
  /** How its last own objectives ended, oldest first. */
  readonly lately: readonly string[];
}

export interface NarrateInput {
  readonly persona: Persona;
  readonly objective: string;
  readonly outcome: "done" | "failed";
  readonly detail: string;
  readonly history: readonly ChatLine[];
}

/** The thinking part of an agent (ADR-008, ADR-011). Code around it only runs the skills it picks. */
export interface Mind {
  /** Chat tier: fast, in character; answers and routes every message it hears. */
  chat(input: ChatInput, signal: AbortSignal): Promise<ChatDecision>;
  /** Work tier (action model): the next step towards an objective, seeing what the last steps did. */
  next(input: WorkInput, signal: AbortSignal): Promise<WorkDecision>;
  /** Goal tier (planner model): the next concrete objective towards the character's own goal. */
  chooseObjective(input: GoalInput, signal: AbortSignal): Promise<string>;
  /** Chat tier: one in-character line reporting how an order ended; empty means say nothing. */
  narrate(input: NarrateInput, signal: AbortSignal): Promise<string>;
}
