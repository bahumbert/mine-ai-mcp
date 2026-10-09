import type { Step } from "./actions.ts";
import type { Opportunity } from "./opportunities.ts";
import type { Persona } from "./persona.ts";
import type { BotSnapshot, PlayerMessage, ProtectedArea } from "./runtime-client.ts";
import type { ActivityTotal } from "./time-spent.ts";

export interface ChatLine {
  readonly speaker: string;
  readonly text: string;
  /**
   * Whom the line spoke to, as this character read it when it heard it (its chat tier's `spoken_to`), or whom it
   * answered with its own line; absent when it never read it (another agent's line).
   */
  readonly to?: readonly string[];
  /** When it was said (ms since the epoch); a conversation goes quiet after a while. */
  readonly at?: number;
}

/**
 * Where the chat tier sends a message (ADR-008): `ignore` not meant for this agent; `talk` reply only; `stop` drop
 * what it is doing; `act` it takes on a request now, setting its current work aside; `later` it takes it on for when
 * its current work is done (ADR-011).
 */
export const ROUTES = ["ignore", "talk", "stop", "act", "later"] as const;
export type Route = (typeof ROUTES)[number];

/** Where a request happens, as the chat tier read it: where the speaker stands, where she stands, a place named, or nowhere in particular. */
export const PLACES = ["speaker", "you", "named", "none"] as const;
export type Place = (typeof PLACES)[number];

/**
 * A place the agent knows because it made it (a house it built): without it, "go to the roof" had no coordinates and
 * the models invented some.
 */
export interface KnownPlace {
  /** e.g. "the small medieval house you built for Tom". */
  readonly name: string;
  /** Coordinates worth going to, e.g. "door -1204 76 803 facing north; stand on its roof at -1206 82 803". */
  readonly detail: string;
  /** A house it built for itself: its own home. */
  readonly own?: boolean;
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
  /** Areas it never digs or places blocks in (ADR-012), oldest first. */
  readonly areas: readonly ProtectedArea[];
  /** Whether a request may wait ("later"): only while it works for someone else. Default true. */
  readonly canWait?: boolean;
}

export interface ChatDecision {
  /** In-character reply spoken right away; empty means stay silent. */
  readonly say: string;
  readonly route: Route;
  /** For `act` and `later`: what the player asked, restated so it stands alone, e.g. "give Steve 5 oak logs". */
  readonly request: string;
  /**
   * The kind of work asked, in the chat tier's own judgment (one of the activities, or "none"); only asked of a
   * character with preferences, so it weighs how it feels before it answers (ADR-015). Empty when not asked.
   */
  readonly work?: string;
  /** Who the line speaks to, as the chat tier read it: names, "everyone" or "unclear" (spec 2026-10-03 fetch-range-and-addressee). */
  readonly to?: readonly string[];
  /** For `act` and `later`: where the request happens, as the chat tier read it (the request already carries the coordinates the code wrote). */
  readonly place?: Place;
  /** For `act` and `later`: the online player the chat tier named as the one asking; the objective's requester when present. */
  readonly for?: string;
  /** With `act`: the chat tier's judgment that its own line starts the work right now. */
  readonly startsNow?: boolean;
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
  /** Areas it never digs or places blocks in (ADR-012), oldest first. */
  readonly areas: readonly ProtectedArea[];
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

/** The same sentence once case, punctuation and spacing are set aside. */
export function sameWords(a: string, b: string): boolean {
  const words = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/gu, " ").trim();
  return words(a) === words(b);
}

export interface GoalInput {
  readonly persona: Persona;
  readonly snapshot: BotSnapshot;
  readonly places: readonly KnownPlace[];
  /** Areas it never digs or places blocks in (ADR-012), oldest first. */
  readonly areas: readonly ProtectedArea[];
  /** How its last own objectives ended, oldest first. */
  readonly lately: readonly string[];
  /** Its last own objective, when it failed, and why: chosen again word for word, it is sent back once. */
  readonly lastFailed?: { readonly objective: string; readonly reason: string } | null;
  /** Things that could use doing, the most pressing first (the tasks a character looks for). */
  readonly opportunities: readonly Opportunity[];
  /** Minutes per activity over the last hour, most first. */
  readonly time: readonly ActivityTotal[];
}

export interface NarrateInput {
  readonly persona: Persona;
  readonly objective: string;
  /** How the order ended, or "progress": what it starts doing now (`detail`), the order still under way. */
  readonly outcome: "done" | "failed" | "progress";
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
  /** Chat tier: one in-character line about an order (how it ended, or what it does now); empty means say nothing. */
  narrate(input: NarrateInput, signal: AbortSignal): Promise<string>;
}
