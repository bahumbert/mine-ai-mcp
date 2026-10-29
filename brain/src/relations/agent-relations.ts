// What an agent holds for relations: the book (saved as notes), the trade controller, and the calls the agent makes into them.
import type { Body } from "../body.ts";
import type { ConversationRelations } from "../conversation/controller.ts";
import { realClock, type Clock } from "../conversation/socialise.ts";
import { memoryNote, relationContextPrefix, relationNotesQuery, type Memory, type Recalled } from "../memory.ts";
import type { ChatDecision, ChatInput, Mind } from "../mind.ts";
import type { Persona } from "../persona.ts";
import type { BotRuntime, BotSnapshot } from "../runtime-client.ts";
import type { SkillContext } from "../skills.ts";
import type { TradeBoard } from "./board.ts";
import { RelationBook } from "./book.ts";
import { resendRefusedTrade } from "./chat-trade.ts";
import { TradeController } from "./controller.ts";
import { awaitTheirSide, handoffOutcome, runHandoff, type Handoff, type HandoffEnd } from "./handoff.ts";
import { openingRelationLines, tooFarLine } from "./prompts.ts";
import { reachOf } from "./trading.ts";
import type { ItemCount, RelationEvent, TradeEvent } from "./types.ts";

/** With only a player's window open (no trade), the tick runs this often at most: it only watches for a payment tossed before the deal. */
const WATCH_LOOK_MS = 2_000;

export type LookAnswer = "ticked" | "busy_wait" | "idle";

export interface AgentRelationsDeps {
  readonly persona: Persona;
  readonly mind: Mind;
  readonly runtime: BotRuntime;
  readonly body: Body;
  /** The agent puts the hand-off on its stack. */
  readonly takeHandoff: (h: Handoff) => void;
  readonly modelSlotFree: () => boolean;
  readonly inConversationWith: (name: string) => boolean;
  /** Whether the name is another agent (a bot of the project), not a player. */
  readonly isAgent: (name: string) => boolean;
  /** What the running objective lacks, as the chat tier is told; the inventory of the snapshot at hand, else the last one looked at. */
  readonly lacks: (inventory?: BotSnapshot["inventory"]) => readonly string[];
  readonly journal: (e: TradeEvent | RelationEvent) => void;
  readonly log: (line: string) => void;
  /** The wall clock the wait for a partner's payment runs on; the real one unless a test moves it. */
  readonly clock?: Clock;
  /** The brain's trade board, when the characters of one process trade with each other. */
  readonly board?: TradeBoard;
}

export class AgentRelations {
  readonly book: RelationBook;
  readonly trades: TradeController;
  /** Note writes run one after the other in the background: the book never waits for the body's queue. */
  private writes: Promise<unknown> = Promise.resolve();
  private looking = false;
  private lastLookAt = 0;

  constructor(private readonly deps: AgentRelationsDeps) {
    const { persona, log } = deps;
    this.book = new RelationBook({ save: (memory) => this.queue(() => this.saveNote(memory)), remove: (context) => this.queue(() => this.forgetNotes(context)), now: () => Date.now(), log });
    this.trades = new TradeController({
      self: persona.username, persona, book: this.book, mind: deps.mind, settings: persona.settings.relations, now: () => Date.now(),
      takeHandoff: deps.takeHandoff, modelSlotFree: deps.modelSlotFree, inConversationWith: deps.inConversationWith, journal: deps.journal, log, ...(deps.board !== undefined && { board: deps.board }),
    });
  }

  /** The records recalled at start. */
  load(recalled: Pick<Recalled, "relations" | "skipped">): void {
    this.book.load(recalled.relations);
    if (recalled.skipped > 0) this.deps.log(`could not read ${recalled.skipped} relation note(s): skipped`);
    this.deps.log(`remembers ${recalled.relations.length} relation(s)`);
  }

  /** The relations block and the trade field for a chat request: the speaker's record, the other members' and what the objective lacks, and that an agent speaker out of reach cannot be gone to. */
  chatBlock(speaker: string, others: readonly string[], snapshot: BotSnapshot): NonNullable<ChatInput["relations"]> {
    const { inReach, away } = reachOf(speaker, snapshot, this.deps.persona.settings.relations.tradeReach);
    // Another agent out of reach: it is told not to offer a walk to them (a player is gone to at any distance).
    const tooFar = this.deps.isAgent(speaker) && !inReach ? tooFarLine(speaker, away) : "";
    return { block: [this.trades.block([speaker, ...others], this.deps.lacks(snapshot.inventory)), tooFar].filter((part) => part !== "").join("\n"), tradeOn: true };
  }

  /** A reply that carries a trade: the trade is checked, and sent back once when the checks refuse it. */
  checkedTrade(first: ChatDecision, input: ChatInput, o: { readonly speaker: string; readonly snapshot: BotSnapshot; readonly signal: AbortSignal }): Promise<ChatDecision> {
    return resendRefusedTrade({ mind: this.deps.mind, input, first, trades: this.trades, log: this.deps.log, ...o });
  }

  /** The trade a decision carries becomes a trade (its line was spoken already); its id when one was proposed or agreed, else null. */
  async decided(decision: ChatDecision, speaker: string, snapshot: BotSnapshot): Promise<string | null> {
    if (decision.trade === undefined) return null;
    return this.trades.onDecision(decision.trade, speaker, snapshot).catch((error: unknown) => {
      this.deps.log(`could not record the trade with ${speaker}: ${String(error)}`);
      return null;
    });
  }

  /** A `give_item` step ended done outside a hand-off: it counts toward my side of the open trade with that player. */
  gaveOutside(player: string, item: string, count: number): void {
    void this.trades.gaveOutside(player, item, count).catch((error: unknown) => this.deps.log(`could not count a give to ${player} in the trade: ${String(error)}`));
  }

  /** What the conversation controller asks of the records. */
  forConversations(): ConversationRelations {
    return {
      blocksFor: (names) => names.map((name) => ({ name, block: this.book.summaries([name], (id) => this.trades.giveProgress(id))[0] ?? "" })),
      openingLines: (names) => openingRelationLines(names.map((partner) => ({ partner, relation: this.book.get(partner) })), this.deps.lacks(), Date.now()),
      ended: (partners) => void this.trades.onConversationEnded(partners).catch((error: unknown) => this.deps.log(`could not note a conversation's judgments: ${String(error)}`)),
    };
  }

  /** The records of those the character has dealt with, for the goal tier. */
  lines(partners: readonly string[]): string[] {
    return this.book.summaries(partners.filter((partner) => this.book.get(partner) !== null), (id) => this.trades.giveProgress(id));
  }

  /**
   * The agent's poll: while a trade is open, its tick runs in the background (never held up by, nor holding up, a step).
   * "ticked": a tick started with the yields; "idle": nothing is open, so no gain is counted; "busy_wait": a tick runs or the watch throttle skipped it, so the yields must wait for the next look.
   */
  look(ownStepYields: ReadonlySet<string>, onStack: ReadonlySet<string>, signal: AbortSignal): LookAnswer {
    const now = (this.deps.clock ?? realClock).now();
    if (signal.aborted || !this.trades.busy()) {
      this.trades.forgetSeen();
      return "idle";
    }
    if (this.looking || (this.trades.onlyWatching() && now - this.lastLookAt < WATCH_LOOK_MS)) return "busy_wait";
    this.looking = true;
    this.lastLookAt = now;
    let ticking = false;
    void (async () => {
      const snapshot = await this.deps.runtime.status();
      this.trades.reconcileHandoffs(onStack);
      ticking = true;
      await this.trades.tick(snapshot, ownStepYields, signal);
    })()
      .catch((error: unknown) => {
        // A tick that started has set its own baseline from the snapshot it read; only a failure before it leaves the old one.
        if (!ticking) this.trades.forgetSeen();
        this.deps.log(`trade check failed: ${String(error)}`);
      })
      .finally(() => { this.looking = false; });
    return "ticked";
  }

  /** Runs one hand-off and tells the controller how it ended. */
  async runHandoff(h: Handoff, context: SkillContext): Promise<HandoffEnd> {
    if (h.kind === "await") return this.awaitPayment(h.tradeId, h.partner, context);
    let end: HandoffEnd;
    try {
      // A give queued behind a long order may find its trade ended meanwhile (a deadline broke it): nothing is given.
      const over = h.kind === "give" ? this.trades.closedAs(h.tradeId) : null;
      if (h.kind === "give" && over !== null) {
        this.trades.handoffSkipped(h.tradeId);
        return { outcome: "failed", detail: `the trade with ${h.partner} is over (${over}): nothing given` };
      }
      // A give made outside this hand-off (another objective's give_item) counts: only what is left is given.
      const left = h.kind === "give" ? this.trades.leftToGive(h.tradeId) ?? [] : h.items;
      if (h.kind === "give" && left.length === 0) {
        this.trades.handoffSkipped(h.tradeId);
        return { outcome: "done", detail: "already handed over" };
      }
      const taken: ItemCount[] = [];
      end = handoffOutcome(await runHandoff(context, { ...h, items: left }, (credit) => taken.push(credit)));
      // What the partner took counts even when the rest was not taken: the retake gives only what is left.
      if (taken.length > 0) await this.trades.tookInHandoff(h.tradeId, taken);
    } catch (error) {
      end = { outcome: "failed", detail: error instanceof Error ? error.message : String(error) };
    }
    if (end.outcome === "dropped") this.trades.handoffDropped(h.tradeId);
    else await this.trades.handoffEnded(h.tradeId, end.outcome, end.detail);
    return end;
  }

  /** The wait for their side: it ends when their payment is credited, at the bound, or when stopped; it never counts as a give. */
  private async awaitPayment(tradeId: string, partner: string, context: SkillContext): Promise<HandoffEnd> {
    const { persona, clock = realClock } = this.deps;
    let end: HandoffEnd;
    try {
      end = handoffOutcome(await awaitTheirSide(context, partner, {
        stillAwaiting: () => this.trades.awaits(tradeId), clock, maxMs: persona.settings.relations.startMinutes * 60_000, openingDistance: persona.settings.conversation.openingDistance,
      }));
    } catch (error) {
      end = { outcome: "failed", detail: error instanceof Error ? error.message : String(error) };
    }
    // A dropped wait may only be set aside below a give or a collect: the controller learns it left the stack from the agent's next look.
    if (end.outcome !== "dropped") this.trades.awaitEnded(tradeId, end.outcome);
    return end;
  }

  private queue(step: () => Promise<void>): Promise<void> {
    this.writes = this.writes.then(step).catch((error: unknown) => this.deps.log(`could not write a relation note: ${String(error)}`));
    return Promise.resolve();
  }

  private async saveNote(memory: Memory): Promise<void> {
    const outcome = await this.deps.body.act("note_save", memoryNote(memory), "Remember what I know of this character.");
    if (outcome.status !== "succeeded") this.deps.log(`could not save a relation (${outcome.status}): ${outcome.error ?? ""}`);
  }

  /** Deletes the older notes of the partner a context (`relation:<partner>`) names. */
  private async forgetNotes(context: string): Promise<void> {
    const partner = context.slice("relation:".length);
    const rows = await this.deps.runtime.queryBotData(relationNotesQuery(this.deps.persona.username, partner));
    const prefix = relationContextPrefix(partner);
    const ids = rows.filter((row) => String(row[1] ?? "").startsWith(prefix)).map((row) => Number(row[0])).filter((id) => Number.isInteger(id));
    if (ids.length === 0) return;
    const outcome = await this.deps.body.act("note_delete", { note_ids: ids }, "Forget the older notes of this relation.");
    if (outcome.status !== "succeeded") this.deps.log(`could not forget old relation notes (${outcome.status}): ${outcome.error ?? ""}`);
  }
}
