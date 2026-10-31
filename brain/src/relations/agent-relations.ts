// What an agent holds for relations: the book (saved as notes), the trade controller, and the calls the agent makes into them.
import type { Body } from "../body.ts";
import type { ConversationRelations } from "../conversation/controller.ts";
import { manhattan } from "../conversation/state.ts";
import { realClock, type Clock } from "../conversation/socialise.ts";
import { memoryNote, relationContextPrefix, relationNotesQuery, type Memory, type Recalled } from "../memory.ts";
import type { ChatDecision, ChatInput, Mind } from "../mind.ts";
import type { Persona } from "../persona.ts";
import type { BotRuntime, BotSnapshot, HurtBy } from "../runtime-client.ts";
import type { SkillContext } from "../skills.ts";
import type { TradeBoard } from "./board.ts";
import { RelationBook } from "./book.ts";
import { resendRefusedTrade } from "./chat-trade.ts";
import { TradeController } from "./controller.ts";
import { awaitTheirSide, handoffOutcome, runHandoff, type Handoff, type HandoffEnd } from "./handoff.ts";
import { ObeyMoods, type ObeyMood } from "./obey.ts";
import { notObeyingLine, openingRelationLines, tooFarLine } from "./prompts.ts";
import { expireRequests, heardFrom, openRequest, answerRequest, requestLines, withExpiredRequests } from "./requests.ts";
import type { DecisionSeen } from "./checks.ts";
import { newRelation } from "./record.ts";
import { drifted, newScoredRows, scoringOf, withHurt } from "./score.ts";
import { reachOf } from "./trading.ts";
import type { ItemCount, Relation, RelationEvent, TradeEvent } from "./types.ts";

/** With only a player's window open (no trade), the tick runs this often at most: it only watches for a payment tossed before the deal. */
const WATCH_LOOK_MS = 2_000;

/** Open requests are looked at for running out this often at most (wall clock). */
const REQUEST_CHECK_MS = 5_000;

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

export type LookAnswer = "ticked" | "busy_wait" | "idle";

export interface AgentRelationsDeps {
  readonly persona: Persona;
  readonly mind: Mind;
  readonly runtime: BotRuntime;
  readonly body: Body;
  /** The agent puts the hand-off on its stack. */
  readonly takeHandoff: (h: Handoff) => void;
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
  /** Blocks (Manhattan) my talk carries: Localized Chat's range when the server has it, else the staying distance. */
  readonly hearingRange: number;
  /** Whether the player is in the game now (at the agent's last look). */
  readonly isOnline: (name: string) => boolean;
  /** A line from that name is in the inbox or its chat decision is still running. */
  readonly waitingFrom: (name: string) => boolean;
  /** The random source of the roll on whether an order is taken (its own, so no other draw moves it); `Math.random` unless a test scripts it. */
  readonly obeyRandom?: () => number;
}

export class AgentRelations {
  readonly book: RelationBook;
  readonly trades: TradeController;
  /** Note writes run one after the other in the background: the book never waits for the body's queue. */
  private writes: Promise<unknown> = Promise.resolve();
  private looking = false;
  private lastLookAt = 0;
  private lastRequestCheckAt = 0;
  private readonly moods: ObeyMoods;

  constructor(private readonly deps: AgentRelationsDeps) {
    const { persona, log } = deps;
    this.moods = new ObeyMoods(persona.settings.relations.obey);
    this.book = new RelationBook({ save: (memory) => this.queue(() => this.saveNote(memory)), remove: (context) => this.queue(() => this.forgetNotes(context)), now: () => this.now(), log, scoring: scoringOf(persona.settings.relations) });
    this.trades = new TradeController({
      self: persona.username, persona, book: this.book, settings: persona.settings.relations, now: () => Date.now(),
      takeHandoff: deps.takeHandoff, journal: deps.journal, log, ...(deps.board !== undefined && { board: deps.board }),
    });
  }

  private now(): number {
    return (this.deps.clock ?? realClock).now();
  }

  /** The records recalled at start; requests that ran out while the brain was away are dropped (nobody watched the wait). */
  load(recalled: Pick<Recalled, "relations" | "skipped">): void {
    const { requestAnswerMinutes } = this.book.scoring.score;
    this.book.load(recalled.relations.map((r) => expireRequests(r, this.now(), requestAnswerMinutes, { atLoad: true }).relation));
    if (recalled.skipped > 0) this.deps.log(`could not read ${recalled.skipped} relation note(s): skipped`);
    this.deps.log(`remembers ${recalled.relations.length} relation(s)`);
  }

  /** The relations block and the trade field for a chat request: the speaker's record, the other members', what the objective lacks, that an agent speaker out of reach cannot be gone to, and that the roll turned the speaker's orders down. */
  chatBlock(speaker: string, others: readonly string[], snapshot: BotSnapshot): NonNullable<ChatInput["relations"]> {
    const { inReach, away } = reachOf(speaker, snapshot, this.deps.persona.settings.relations.tradeReach);
    // Another agent out of reach: it is told not to offer a walk to them (a player is gone to at any distance).
    const tooFar = this.deps.isAgent(speaker) && !inReach ? tooFarLine(speaker, away) : "";
    const mine = this.book.get(speaker);
    const { mood, current } = this.rollFor(speaker);
    const refusing = mood.obeys ? "" : notObeyingLine(speaker, current);
    const seenOfferId = this.deps.board?.offerFrom(speaker, this.deps.persona.username)?.id;
    return {
      block: [this.trades.block([speaker, ...others], this.deps.lacks(snapshot.inventory)), tooFar, refusing].filter((part) => part !== "").join("\n"),
      tradeOn: true, requests: mine === null ? [] : requestLines(mine, speaker, this.now()), ...(seenOfferId !== undefined && { seenOfferId }),
    };
  }

  /** Whether the speaker's orders are taken now: the stored roll while it holds, else a new one on the drifted score (the first impression for a stranger). */
  private rollFor(speaker: string): { readonly mood: ObeyMood; readonly current: number } {
    const current = this.rating(speaker);
    return { mood: this.moods.moodOf(speaker, current, this.now(), this.deps.obeyRandom ?? Math.random), current };
  }

  /** How I rate the speaker now: the stored score drifted to this moment (the first impression for a stranger). */
  rating(speaker: string): number {
    const now = this.now();
    const { temperament } = this.book.scoring;
    return drifted(this.book.get(speaker) ?? newRelation(speaker, now, temperament.firstImpression), now, temperament).score;
  }

  /** Whether the speaker's offer to me on the board is still the one that was read (`seenOfferId`): a reply that read an offer applies only to it. */
  offerStillStands(speaker: string, seenOfferId: string | undefined): boolean {
    return seenOfferId !== undefined && this.deps.board?.offerFrom(speaker, this.deps.persona.username)?.id === seenOfferId;
  }

  /** The roll made for the speaker's line (read without expiry: a long model call never rolls twice); null when none was made, so the order is taken. */
  obeys(speaker: string): ObeyMood | null {
    return this.moods.stored(speaker);
  }

  /** The id of the trade or board offer open between me and the speaker (mine first, then an offer either way), else null. */
  tradeOpenWith(speaker: string): string | null {
    const { board, persona } = this.deps;
    return this.trades.openWith(speaker)?.id ?? board?.offerFrom(speaker, persona.username)?.id ?? board?.offerFrom(persona.username, speaker)?.id ?? null;
  }

  /** A reply that carries a trade: the trade is checked, and sent back once when the checks refuse it. */
  checkedTrade(first: ChatDecision, input: ChatInput, o: { readonly speaker: string; readonly snapshot: BotSnapshot; readonly signal: AbortSignal }): Promise<ChatDecision> {
    return resendRefusedTrade({ mind: this.deps.mind, input, first, trades: this.trades, log: this.deps.log, ...o });
  }

  /** The trade a decision carries becomes a trade (its line was spoken already); its id when one was proposed or agreed, else null. `seen` is what the answered line was read against. */
  async decided(decision: ChatDecision, speaker: string, snapshot: BotSnapshot, seen?: Pick<DecisionSeen, "heardAt" | "seenOfferId">): Promise<string | null> {
    if (decision.trade === undefined) return null;
    return this.trades.onDecision(decision.trade, speaker, snapshot, seen === undefined ? undefined : { ...seen, say: decision.say }).catch((error: unknown) => {
      this.deps.log(`could not record the trade with ${speaker}: ${String(error)}`);
      return null;
    });
  }

  /** The speaker's line answered one of my open requests: a refusal or a done scores in the same write that closes it. */
  async answered(decision: ChatDecision, speaker: string): Promise<void> {
    const mine = decision.myRequest;
    if (mine === undefined) return;
    const before = this.book.get(speaker);
    if (before === null || before.requests[mine.n - 1] === undefined) return void this.deps.log(`my_request ${mine.n} (${mine.answer}) from ${speaker} names no open request: ignored`);
    await this.scoredUpdate(speaker, (r) => answerRequest(r, mine.n, mine.answer, this.now(), this.book.scoring))
      .catch((error: unknown) => this.deps.log(`could not note ${speaker}'s answer to my request: ${String(error)}`));
  }

  /** One book update that journals a row for each event it added, and only those (rows are told apart inside the update, so a change queued by another writer is not counted twice). */
  private async scoredUpdate(partner: string, change: (r: Relation) => Relation): Promise<void> {
    let rows: RelationEvent[] = [];
    await this.book.update(partner, (r) => {
      const next = change(r);
      rows = newScoredRows(r, next);
      return next;
    });
    for (const row of rows) this.deps.journal(row);
  }

  /** My own line asked these characters for something: each becomes an open request (heard, or not, when it was said). */
  asked(names: readonly string[], what: string, whisperTo: string | null, snapshot: BotSnapshot): void {
    const now = this.now();
    for (const name of names) {
      const online = snapshot.players.find((p) => same(p.username, name));
      const known = this.book.get(name);
      if (same(name, this.deps.persona.username) || (online === undefined && known === null)) continue;
      const heard = online !== undefined && ((whisperTo !== null && same(whisperTo, name)) || (online.position !== null && manhattan(online.position, snapshot.position) <= this.deps.hearingRange));
      void this.book.update(online?.username ?? known?.partner ?? name, (r) => openRequest(r, what, now, heard)).catch((error: unknown) => this.deps.log(`could not note my request to ${name}: ${String(error)}`));
    }
  }

  /** A line to me from this character, read at `at`: the requests I made of them before it are answered, so their silence is never scored. A stranger gets no record. */
  heardFrom(name: string, at: number = this.now()): void {
    if (this.book.get(name) === null) return;
    // No look at the open requests here: the ask's own update may still be queued, and this one runs after it.
    void this.book.update(name, (r) => heardFrom(r, at)).catch((error: unknown) => this.deps.log(`could not note a line from ${name} against my requests: ${String(error)}`));
  }

  /** A player hit me: it scores as a `hurt` unless this attacker's last hit is inside the debounce window (decided inside the update, so two hits in one tick score once). */
  hurt(h: HurtBy): void {
    const now = this.now();
    void this.scoredUpdate(h.attacker, (r) => withHurt(r, h.direct, now, this.book.scoring))
      .catch((error: unknown) => this.deps.log(`could not note the hit by ${h.attacker}: ${String(error)}`));
  }

  /** Requests that ran out are closed and the ignored ones score, as the clock says (no model call, no brain tick needed). */
  private expireOpenRequests(): void {
    const now = this.now();
    if (now - this.lastRequestCheckAt < REQUEST_CHECK_MS) return;
    this.lastRequestCheckAt = now;
    const { requestAnswerMinutes } = this.book.scoring.score;
    for (const r of this.book.records()) {
      const o = { waiting: this.deps.waitingFrom(r.partner), offline: !this.deps.isOnline(r.partner) };
      if (expireRequests(r, now, requestAnswerMinutes, o).relation === r) continue;
      void this.scoredUpdate(r.partner, (current) => {
        // Read inside the update: a line queued before it may have marked a request heard since this look.
        for (const q of expireRequests(current, now, requestAnswerMinutes, o).heardDropped) this.deps.log(`request to ${r.partner} for ${q.what} dropped: they spoke since`);
        return withExpiredRequests(current, now, this.book.scoring, o);
      })
        .catch((error: unknown) => this.deps.log(`could not close my requests to ${r.partner}: ${String(error)}`));
    }
  }

  /** A `give_item` step ended done outside a hand-off: it counts toward my side of the open trade with that player. */
  gaveOutside(player: string, item: string, count: number): void {
    void this.trades.gaveOutside(player, item, count).catch((error: unknown) => this.deps.log(`could not count a give to ${player} in the trade: ${String(error)}`));
  }

  /** What the conversation controller asks of the records. */
  forConversations(): ConversationRelations {
    return {
      blocksFor: (names) => names.map((name) => ({ name, block: this.book.summaries([name], (id) => this.trades.giveProgress(id))[0] ?? "" })),
      openingLines: (names) => openingRelationLines(names.map((partner) => ({ partner, relation: this.book.get(partner) })), this.deps.lacks(), Date.now(), this.book.scoring),
      asked: (names, what, snapshot) => this.asked(names, what, null, snapshot),
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
    const now = this.now();
    if (!signal.aborted) this.expireOpenRequests();
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
    const outcome = await this.deps.body.act("note_save", memoryNote(memory, this.book.scoring), "Remember what I know of this character.");
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
