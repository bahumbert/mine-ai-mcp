/** The types of a character's conversation controller: its dependencies, the facts of an opening and the talks it keeps. */
import type { BrainEvent } from "../brain-log.ts";
import type { Memory } from "../memory.ts";
import type { ChatLine, GistPartner, Mind, OpeningInput } from "../mind.ts";
import type { Persona } from "../persona.ts";
import type { BotSnapshot } from "../runtime-client.ts";
import type { ConversationBudget } from "./budget.ts";

export type ConversationEvent = Extract<BrainEvent, { kind: "conversation" }>;
export type ConversationMemory = Extract<Memory, { kind: "conversation" }>;

/** What the relations feature adds to a conversation (spec 2026-10-19-relations-trading-design): records in, judgments out. */
export interface ConversationRelations {
  /** Each named member's record text, given to the gist call (which then also judges them). */
  readonly blocksFor: (names: readonly string[]) => readonly { readonly name: string; readonly block: string }[];
  /** An opening line asked these names for something: each becomes an open request. */
  readonly asked: (names: readonly string[], what: string, snapshot: BotSnapshot) => void;
  /** One line per nearby partner for an opening call. */
  readonly openingLines: (names: readonly string[]) => readonly string[];
  /** The gist's judgment of the members, once a gist call returned them. */
  readonly ended: (partners: readonly GistPartner[]) => void;
}

export interface ControllerDeps {
  readonly self: string;
  readonly persona: Persona;
  readonly mind: Mind;
  readonly budget: ConversationBudget;
  /** Whether the model queue has a free slot: openings and gists are skipped, never queued. */
  readonly modelFree: () => boolean;
  /** Resolves true once a model slot is free within `ms`, false on time-out or abort; absent: a gist does not wait. */
  readonly waitForModel?: (ms: number, signal: AbortSignal) => Promise<boolean>;
  /** Blocks (Manhattan) talk carries: the Localized Chat range, else the staying distance. */
  readonly talkRange: number;
  /** Milliseconds between two looks of a waiting deliberate opening; default `OPEN_POLL_MS` of the controller (1 000). */
  readonly openPollMs?: number;
  /** Whether the server limits how far talk carries (Localized Chat): only then is a call shouted. */
  readonly localized?: boolean;
  readonly random: () => number;
  /** Monotonic milliseconds (`monotonicNow`): every window of the controller (cooldown, minutes cap, checks, the ask stamps). Never compared with {@link ControllerDeps.wallNow}. */
  readonly now: () => number;
  /** Wall milliseconds (`Date.now`): what is written down or shown (a talk's end, its age) and the chat history's line times. */
  readonly wallNow: () => number;
  /** Resolves once the line is sent; rejects when it was not. */
  readonly speak: (text: string, to: readonly string[], whisperTo: string | null, shout: boolean) => Promise<void>;
  readonly journal: (event: ConversationEvent) => void;
  readonly memorize: (memory: ConversationMemory) => void;
  readonly log: (line: string) => void;
  readonly history: () => readonly ChatLine[];
  /** Absent: the feature is off, the gist and the opening are as before. */
  readonly relations?: ConversationRelations;
}

export interface OpenFacts {
  readonly snapshot: BotSnapshot;
  readonly activity: string;
  readonly lately: readonly string[];
  readonly lastFailed: OpeningInput["lastFailed"];
  readonly intent?: OpeningInput["intent"];
}

export interface Talk {
  readonly with: readonly string[];
  readonly topic: string;
  readonly gist: string;
  /** Wall time: it is stored in the memory as an ISO date and compared with an objective's wall start. */
  readonly endedAt: number;
}

export interface CarriedIntent {
  readonly partner: string;
  readonly intent: NonNullable<OpeningInput["intent"]>;
  readonly carriedAt: number;
  /** A chat call was shown the intent: her next line is the ask. */
  shown: boolean;
}
