// What an Agent is made from (re-exported by agent.ts, which every caller imports it from).
import type { TypingPace } from "../body.ts";
import type { BrainEvent } from "../brain-log.ts";
import type { ConversationBudget } from "../conversation/controller.ts";
import type { EveryoneLines } from "../everyone-lines.ts";
import type { TillFacts } from "../farming/site.ts";
import type { LocalizedChat } from "../llm-mind.ts";
import type { Mind } from "../mind.ts";
import type { Persona } from "../persona.ts";
import type { TradeBoard } from "../relations/board.ts";
import type { BotRuntime } from "../runtime-client.ts";
import type { SpeakerBudget } from "../speaker-budget.ts";

export interface AgentOptions {
  readonly persona: Persona;
  readonly runtime: BotRuntime;
  readonly mind: Mind;
  /**
   * Usernames of the other agents. Their lines are answered only inside a conversation (a member of it, or a line
   * naming this character or a member), so two bots cannot talk each other into an endless chatter; with
   * {@link AgentOptions.conversations} absent they are never answered. `OtherAgents` (fixed names, and the launcher's
   * file when there is one) is asked on every line: a bot started from game chat joins the list while this one runs.
   */
  readonly otherAgents: { names(): readonly string[] };
  /** Conversations (spec 2026-10-18-conversations-design); absent: the character holds none. */
  readonly conversations?: { readonly budget: ConversationBudget; readonly modelFree: () => boolean; readonly waitForModel?: (ms: number, signal: AbortSignal) => Promise<boolean> };
  /**
   * The lines to everyone the brain's agents heard, shared by all of them: a greeting that asks nothing is answered by
   * the bot nearest the speaker only. Absent: such a line is never answered.
   */
  readonly everyone?: EveryoneLines;
  /** The brain's chat-tier decisions per speaker (spec 2026-11-18-chat-flood-bounds D3), shared by its agents. Absent: no bound. */
  readonly speakerBudget?: SpeakerBudget;
  /** The owner's stop words (spec 2026-11-18-model-call-lanes D3): a line that is only one of them, and is hers, stops her in the poll that reads it. Absent or empty: only the chat tier's `stop` route stops. */
  readonly stopWords?: readonly string[];
  /** The trade board shared by the agents of one process: a trade between two of them is made on the proposer's terms. Absent: every partner is outside the brain. */
  readonly tradeBoard?: TradeBoard;
  /** The server's Localized Chat, when the brain is told it runs: talk carries its range, and a call may be shouted. */
  readonly localizedChat?: LocalizedChat;
  readonly log: (line: string) => void;
  /** The block names a till failed on, shared by the agents of one process (each agent has its own when none is given). */
  readonly soil?: TillFacts;
  readonly pollMs?: number;
  /** How often a conversation reads the status (default 2 s); tests that watch it fail and recover use a short one. */
  readonly talkLookMs?: number;
  /** Chat typing pace; tests use instant typing. */
  readonly typing?: TypingPace;
  /** Told what the character takes on, does and reports (the brain log, read by the monitor). */
  readonly journal?: (event: BrainEvent) => void;
  /** Where the activity draw gets its chance, a number in [0, 1); tests inject a seeded one. Default `Math.random`. */
  readonly random?: () => number;
  /** The source of the roll on whether an order is taken (its own: no other draw moves it). Default `Math.random`; tests script it. */
  readonly obeyRandom?: () => number;
  /** People talked to who are not players here (e.g. the controller): a message opening with their name, then a comma, calls them. Default none. */
  readonly knownNames?: readonly string[];
  /** Minutes without any target item gained before a step is stopped, and how often the inventory is looked at; tests shorten them. */
  readonly noGain?: { readonly minutes: number; readonly sampleMs: number };
}
