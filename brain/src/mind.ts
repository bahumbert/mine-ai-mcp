import type { Step } from "./actions.ts";
import type { Activity } from "./activities.ts";
import type { Facing } from "./building/blueprint.ts";
import type { HouseSize } from "./building/house.ts";
import type { Materials } from "./building/plan.ts";
import type { ActivityChance } from "./activity-draw.ts";
import type { ConversationKind, PlannedLength } from "./conversation/state.ts";
import type { Opportunity } from "./opportunities.ts";
import type { Persona } from "./persona.ts";
import type { Handoff } from "./relations/handoff.ts";
import type { ItemCount, Judged, Trade } from "./relations/types.ts";
import type { BotSnapshot, PlayerMessage, Position, ProtectedArea } from "./runtime-client.ts";
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
  /**
   * A house it built: what is needed to build it again in place. `materials` holds only the roles built with other
   * blocks than the style's; any such role makes the house temporary. Older notes have none.
   */
  readonly house?: {
    readonly size: HouseSize;
    readonly style: string;
    readonly door: Position;
    readonly facing: Facing;
    readonly materials: Materials;
  };
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
  /** People talked to who are not players here (the controller, say), from the brain's `--known-names`; a name called in a message. */
  readonly knownNames?: readonly string[];
  /** The character the speaker's latest line naming one was for, when this line names none and that was lately (see Agent.talkedTo). */
  readonly talkedTo?: { readonly name: string; readonly secondsAgo: number };
  /** The conversation this line is part of, when the character is in one (spec 2026-10-18-conversations-design). */
  readonly conversation?: ConversationFacts;
  /** For a line to everyone that asks nothing: true for the one bot that answers it (the nearest the speaker); absent: none does. */
  readonly claimEveryoneLine?: () => boolean;
  /** The relations block of the speaker and the other members, and whether the trade field is offered (spec 2026-10-19-relations-trading-design). */
  readonly relations?: { readonly block: string; readonly tradeOn: boolean };
}

/** The chat tier's trade decision on a line: propose, accept, decline or cancel a swap; sides are item ids with counts. */
export interface TradeDecision {
  readonly action: "propose" | "accept" | "decline" | "cancel";
  readonly give: readonly ItemCount[];
  readonly get: readonly ItemCount[];
  readonly first: "me" | "them";
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
  /** With `act`: the chat tier's judgment that its own line starts the work right now. */
  readonly startsNow?: boolean;
  /** Only on a server with localized chat: the line is shouted, so everyone hears it. */
  readonly shout?: boolean;
  /** The line ends the conversation for the character (a goodbye); only asked inside one. */
  readonly close?: boolean;
  /** A swap of items the line proposes, accepts, declines or cancels; only read when `ChatInput.relations.tradeOn`. */
  readonly trade?: TradeDecision;
}

/** Something the agent works towards: an order from someone, or a step of its own goal (`requester` null). */
export interface Objective {
  readonly text: string;
  readonly requester: string | null;
  /**
   * The kind of work it is for (spec 2026-10-09-activity-draw), in the models' own reading: the goal tier's "for", or the
   * chat tier's "work" for a request; null when none. Every step under the objective counts its time for it.
   */
  readonly purpose: Activity | null;
  /** For an order: where the chat tier read it happens ("you": around the bot itself; the request carries the coordinates). */
  readonly place?: Place;
  /** A trade's hand-off (spec 2026-10-19-relations-trading-design): a code routine, its own decision, never an order. */
  readonly handoff?: Handoff;
}

/** One step already taken for the current objective, as the work tier sees it. */
export interface StepRecord {
  readonly step: string;
  readonly outcome: "done" | "failed" | "interrupted";
  readonly detail: string;
}

/** How long a failed step is remembered, and how many failures in that time refuse it (owner, 2026-10-10: one retry). */
export const FAILED_STEP_MINUTES = 30;
export const MAX_STEP_FAILURES = 2;
/** Refusals of the same step (none of it run in between) that end the objective (owner, 2026-10-11, rule 2). */
export const MAX_REFUSALS = 3;
/** How far it must have moved since a step last failed for the step to be allowed again. */
export const MOVED_BLOCKS = 8;

/** A step that failed lately, for any objective (its key from `stepKey`); its second failure refuses it. */
export interface EarlierFailure {
  readonly step: string;
  readonly key: string;
  readonly detail: string;
  readonly objective: string;
  readonly minutesAgo: number;
  /** How many times it failed in the last {@link FAILED_STEP_MINUTES} minutes (the latest is the one shown). */
  readonly count: number;
  /** The inventory or the position differs from the state after its last failure: a refused step is then allowed again. */
  readonly changed: boolean;
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
  /** Steps that failed lately for any of its objectives, most recent first: sent again once they run, after a second failure they are refused. */
  readonly earlierFailures?: readonly EarlierFailure[];
  /** It owns a house with temporary parts: only then is `improve_house` offered in the skill list. */
  readonly ownsTemporaryHouse?: boolean;
  /** Step key -> refusals since that step last ran; mutable, owned by the agent's work for this objective (counted here, reset there). */
  readonly refused?: Map<string, number>;
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
  /**
   * The activities drawn for this call, by their chances (spec 2026-10-09-activity-draw): what it feels like doing now,
   * the first, else the second. Empty when none is available.
   */
  readonly drawn: readonly Activity[];
  /** The chance of each available activity, most likely first: the kinds of work its "for" may name. */
  readonly chances: readonly ActivityChance[];
  /** What it knows of the others it could talk to: one record text per partner it has dealt with. */
  readonly relations?: readonly string[];
}

/** The goal tier's answer: the objective, and the kind of work it is for (null when it named none we know). */
export interface ChosenObjective {
  readonly text: string;
  readonly purpose: Activity | null;
}

export interface NarrateInput {
  readonly persona: Persona;
  readonly objective: string;
  /** How the order ended, or "progress": what it starts doing now (`detail`), the order still under way. */
  readonly outcome: "done" | "failed" | "progress";
  readonly detail: string;
  readonly history: readonly ChatLine[];
}

/** What the code knows of a past conversation with someone, for the prompts. */
export interface PastTalk {
  readonly with: readonly string[];
  readonly topic: string;
  readonly gist: string;
  readonly minutesAgo: number;
}

/** The facts of the conversation a chat request is in (the "This conversation" block). */
export interface ConversationFacts {
  readonly kind: ConversationKind;
  /** The other members. */
  readonly others: readonly string[];
  /** Who opened it (this character or one of the others). */
  readonly opener: string;
  readonly topic: string;
  readonly planned: PlannedLength | null;
  readonly lines: number;
  readonly minutes: number;
  readonly iAmOpener: boolean;
  /** The cap is reached: it says goodbye now. */
  readonly sayGoodbye: boolean;
  readonly lastGists: readonly PastTalk[];
  /** A trade the routine came to ask for, while this talk is with its partner and the ask has not been made. */
  readonly intent?: NonNullable<OpeningInput["intent"]> & { readonly partner: string };
}

/** Someone near enough to talk to. */
export interface Nearby {
  readonly username: string;
  /** Blocks (Manhattan); null when out of sight. */
  readonly distance: number | null;
  readonly lastTalk: PastTalk | null;
}

export interface OpeningInput {
  readonly persona: Persona;
  readonly kind: ConversationKind;
  readonly near: readonly Nearby[];
  readonly activity: string;
  readonly lately: readonly string[];
  readonly lastFailed: { readonly objective: string; readonly reason: string } | null;
  /** Social, partner out of earshot: the line is shouted to call them over. */
  readonly calling: boolean;
  /** One summary line per nearby partner, with what they said they have against what the objective lacks. */
  readonly relations?: readonly string[];
  /** The trading routine came to ask for these items and can offer these stacks. */
  readonly intent?: { readonly kind: "trade"; readonly want: readonly string[]; readonly offer: readonly ItemCount[] };
}

export interface OpeningDecision {
  readonly open: boolean;
  readonly to: readonly string[];
  readonly topic: string;
  readonly length: PlannedLength;
  readonly say: string;
}

export interface GistInput {
  readonly persona: Persona;
  readonly others: readonly string[];
  readonly topic: string;
  readonly lines: readonly ChatLine[];
  /** Each other member's record text; given: the gist also judges them and notes what they said they have or need. */
  readonly relations?: readonly { readonly name: string; readonly block: string }[];
}

/** What the model judged of one member of a finished conversation. */
export interface GistPartner {
  readonly name: string;
  readonly judged: Judged | null;
  readonly has: readonly string[];
  readonly needs: readonly string[];
}

export interface Gist {
  readonly gist: string;
  readonly partners: readonly GistPartner[];
}

export interface JudgeInput {
  readonly persona: Persona;
  readonly partner: string;
  readonly block: string;
  readonly trade: Trade;
}

/** The thinking part of an agent (ADR-008, ADR-011). Code around it only runs the skills it picks. */
export interface Mind {
  /** Chat tier: fast, in character; answers and routes every message it hears. */
  chat(input: ChatInput, signal: AbortSignal): Promise<ChatDecision>;
  /** Work tier (action model): the next step towards an objective, seeing what the last steps did. */
  next(input: WorkInput, signal: AbortSignal): Promise<WorkDecision>;
  /** Goal tier (planner model): the next concrete objective towards the character's own goal. */
  chooseObjective(input: GoalInput, signal: AbortSignal): Promise<ChosenObjective>;
  /** Chat tier: one in-character line about an order (how it ended, or what it does now); empty means say nothing. */
  narrate(input: NarrateInput, signal: AbortSignal): Promise<string>;
  /** Chat tier: whether and how to open a conversation with those near; `open: false` when it has nothing to say. */
  openConversation(input: OpeningInput, signal: AbortSignal): Promise<OpeningDecision>;
  /** Chat tier: one sentence to remember a finished conversation by. */
  sumUpConversation(input: GistInput, signal: AbortSignal): Promise<Gist>;
  /** Chat tier: how a trade that ended outside a conversation changes the feeling for the partner; null when the reply is unusable. */
  judgeRelation(input: JudgeInput, signal: AbortSignal): Promise<Judged | null>;
}
