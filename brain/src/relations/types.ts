// Shapes of the relations and trading feature (no logic): a relationship record per partner and the trades in it.
import type { Persona } from "../persona.ts";

export interface ItemCount {
  readonly item: string;
  readonly count: number;
}

export type TradeState = "proposed" | "agreed" | "i_gave" | "they_gave" | "done" | "broken" | "cancelled";

export interface Trade {
  /** `${self}-${partner}-${agreedOrProposedAt}`. */
  readonly id: string;
  readonly partner: string;
  /** My side, as I understood the deal. */
  readonly give: readonly ItemCount[];
  /** Their side, as I understood it; [] = a gift from me. */
  readonly get: readonly ItemCount[];
  readonly first: "me" | "them";
  readonly state: TradeState;
  readonly createdAt: number;
  readonly agreedAt: number | null;
  /** When their payment last came in (null before any; an old note has none): the clock of the deadline for my give. */
  readonly receivedAt: number | null;
  /** When my side was handed over. */
  readonly gaveAt: number | null;
  /** Credited so far from the partner. */
  readonly received: readonly ItemCount[];
  readonly endedAt: number | null;
  /** "me": my give failed (iFailedToPay); "them": they did not pay in time. */
  readonly brokenBy: "me" | "them" | null;
  /** Paid in full after the deadline (keptLate). */
  readonly late: boolean;
  /** Why it ended, for the model ("they paid 3 of 5 iron_ingot"). */
  readonly note: string;
}

export interface RelationFacts {
  readonly tradesDone: number;
  readonly promisesKept: number;
  readonly keptLate: number;
  readonly promisesBroken: number;
  readonly iFailedToPay: number;
  readonly giftsGiven: number;
  readonly giftsReceived: number;
}

export interface SaidItem {
  readonly item: string;
  readonly count: number | null;
  readonly at: number;
}

export type ScoreKind = "trade_done" | "kept_late" | "promise_broken" | "gift_received"
  | "request_helped" | "request_refused" | "request_ignored" | "hurt" | "nudge" | "earlier";

/** One thing that moved a score; `delta` is what was actually applied (clamping included). */
export interface ScoreEvent {
  readonly kind: ScoreKind;
  readonly delta: number;
  readonly why: string;
  readonly at: number;
  /** The trade a `promise_broken` or `kept_late` belongs to. */
  readonly tradeId?: string;
}

/** What I asked of a partner and have no answer to yet. */
export interface OpenRequest {
  readonly what: string;
  readonly at: number;
  /** The partner was within hearing when I asked. */
  readonly inRange: boolean;
  readonly agreed: boolean;
}

export type Temperament = Persona["settings"]["relations"]["temperament"];
export type ScoreSettings = Persona["settings"]["relations"]["score"];

/** What turns an event into a score change: the amounts and this character's temperament. */
export interface Scoring {
  readonly score: ScoreSettings;
  readonly temperament: Temperament;
}

/** An event to score; `nudge` is the model's value for kind "nudge". */
export interface ScoreInput {
  readonly kind: ScoreKind;
  readonly why: string;
  readonly nudge?: number;
  readonly tradeId?: string;
}

/** Words for a score in prompts only; no code decides by a band (Rule #0). */
export type Band = "enemy" | "dislike" | "neutral" | "like" | "friend";

export interface Relation {
  readonly partner: string;
  /** -100..100, with fractions (drift is exact); shown rounded. One way: my opinion of them. */
  readonly score: number;
  /** Wall clock ms of the last drift applied to `score`. */
  readonly scoredAt: number;
  /** The latest events that moved the score, newest last. */
  readonly ledger: readonly ScoreEvent[];
  /** What I asked of them and have no answer to yet (at most 3). */
  readonly requests: readonly OpenRequest[];
  /** When a hurt by them was last scored (the debounce); null before any. */
  readonly lastHurt: number | null;
  readonly facts: RelationFacts;
  /** Open trades plus the last 3 ended ones. */
  readonly trades: readonly Trade[];
  readonly saidHas: readonly SaidItem[];
  readonly saidNeeds: readonly SaidItem[];
  readonly lastDealt: number;
}

/** What of my side is already given, and why a due give waits (null: it is not waiting). */
export interface GiveProgress {
  readonly given: readonly ItemCount[];
  readonly waits: "partner_away" | "retake" | null;
  /** The opening distance a failed give waits for (`persona.settings.conversation.openingDistance`). */
  readonly nearWithin: number;
}

/** Trade times are set in minutes. */
export const MINUTE_MS = 60_000;

export interface TradeSettings {
  readonly payBackMinutes: number;
  readonly startMinutes: number;
  readonly handoffDistance: number;
  readonly offersForgetMinutes: number;
  readonly maxOpenTrades: number;
  /** A partner counts for trading only when seen and at most this many blocks away (Manhattan). */
  readonly tradeReach: number;
}

/** Journal row for a trade's step (read by the monitor). */
export interface TradeEvent {
  readonly kind: "trade";
  readonly event: "proposed" | "agreed" | "gave" | "received" | "done" | "broken" | "cancelled";
  readonly partner: string;
  readonly tradeId: string;
  readonly give: readonly ItemCount[];
  readonly get: readonly ItemCount[];
  readonly first: "me" | "them";
  readonly note: string;
}

/** Journal row for an event that moved a score (read by the monitor). */
export interface RelationEvent {
  readonly kind: "relation";
  readonly event: "scored";
  readonly partner: string;
  readonly scoreKind: ScoreKind;
  readonly delta: number;
  readonly score: number;
  readonly why: string;
}
