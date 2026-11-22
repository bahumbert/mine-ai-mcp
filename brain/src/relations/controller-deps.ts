// What a trade controller is given: who it is, its book and settings, its two clocks, and where it sends hand-offs, journal rows and log lines.
import type { Persona } from "../persona.ts";
import type { RelationBook } from "./book.ts";
import type { TradeBoard } from "./board.ts";
import type { Handoff } from "./handoff.ts";
import type { RelationEvent, TradeEvent, TradeSettings } from "./types.ts";

export interface TradeControllerDeps {
  readonly self: string;
  readonly persona: Persona;
  readonly book: RelationBook;
  readonly settings: TradeSettings;
  /** Monotonic: the ledgers' windows, the retake waits (never written, never compared with a trade's time). */
  readonly now: () => number;
  /** Wall time: a trade's own times, the book, the scores and the pay-back clock, which are stored and compared with stored times. */
  readonly wallNow: () => number;
  /** The agent pushes the routine objective for this hand-off. */
  readonly takeHandoff: (h: Handoff) => void;
  readonly journal: (e: TradeEvent | RelationEvent) => void;
  readonly log: (line: string) => void;
  /** The brain's trade board: a trade with another bot of this brain is made on the proposer's terms. Absent: every partner is treated as outside the brain. */
  readonly board?: TradeBoard;
}
