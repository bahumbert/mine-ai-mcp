// Shapes of the relations and trading feature (no logic): a relationship record per partner and the trades in it.

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

export interface Relation {
  readonly partner: string;
  /** -3..+3, set by the model only; 0 for someone new. */
  readonly feeling: number;
  /** The model's word ("friend", "wary"); "" for someone new. */
  readonly word: string;
  /** One sentence, the model's. */
  readonly why: string;
  readonly facts: RelationFacts;
  /** Open trades plus the last 3 ended ones. */
  readonly trades: readonly Trade[];
  readonly saidHas: readonly SaidItem[];
  readonly saidNeeds: readonly SaidItem[];
  readonly lastDealt: number;
}

export interface TradeSettings {
  readonly payBackMinutes: number;
  readonly startMinutes: number;
  readonly handoffDistance: number;
  readonly offersForgetMinutes: number;
  readonly maxOpenTrades: number;
}

/** The model's judgment of a partner. */
export interface Judged {
  readonly feeling: number;
  readonly word: string;
  readonly why: string;
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

/** Journal row for a feeling the model set. */
export interface RelationEvent {
  readonly kind: "relation";
  readonly event: "judged";
  readonly partner: string;
  readonly from: number;
  readonly to: number;
  readonly word: string;
  readonly why: string;
  readonly by: "gist" | "judge";
}
