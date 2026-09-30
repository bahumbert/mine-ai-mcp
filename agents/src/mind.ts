import type { Step } from "./actions.ts";
import type { Persona } from "./persona.ts";
import type { BotSnapshot, PlayerMessage } from "./runtime-client.ts";

export interface ChatLine {
  readonly speaker: string;
  readonly text: string;
}

/**
 * Where the chat tier sends a message (ADR-008): `ignore` not meant for this agent; `talk` reply only; `stop` drop
 * the current task; `act` a simple request for the action tier; `plan` a request that needs the planner tier.
 */
export const ROUTES = ["ignore", "talk", "stop", "act", "plan"] as const;
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
  /** For `act`/`plan`: the request restated so it stands alone, e.g. "give Steve 5 oak logs". */
  readonly request: string;
}

export interface TaskInput {
  readonly persona: Persona;
  readonly request: string;
  /** Who asked, so "me" can be resolved to a username. */
  readonly requester: string;
  readonly snapshot: BotSnapshot;
  readonly activity: string;
  readonly places: readonly KnownPlace[];
}

export type Resolution =
  | { readonly kind: "steps"; readonly steps: readonly Step[] }
  /** The action tier needs the planner. */
  | { readonly kind: "escalate"; readonly reason: string }
  /** Nothing in the skill catalog can do it. */
  | { readonly kind: "impossible"; readonly reason: string };

export interface NarrateInput {
  readonly persona: Persona;
  readonly task: string;
  /** `escalated`: the request turned out to need the planner, so the agent thinks before starting. */
  readonly outcome: "done" | "failed" | "escalated";
  readonly detail: string;
  readonly history: readonly ChatLine[];
}

/** The thinking part of an agent: three model tiers (ADR-008). Code around it enforces stance and runs skills. */
export interface Mind {
  /** Chat tier: fast, in character; answers and routes every message it hears. */
  chat(input: ChatInput, signal: AbortSignal): Promise<ChatDecision>;
  /** Action tier: maps a simple request to a few skill steps, or escalates. */
  resolve(input: TaskInput, signal: AbortSignal): Promise<Resolution>;
  /** Planner tier: longer plans for requests the action tier could not map directly. Never escalates. */
  plan(input: TaskInput, signal: AbortSignal): Promise<Exclude<Resolution, { kind: "escalate" }>>;
  /** Chat tier: one in-character line reporting how a task ended or that it needs thinking; empty means say nothing. */
  narrate(input: NarrateInput, signal: AbortSignal): Promise<string>;
}
