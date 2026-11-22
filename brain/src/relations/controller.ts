// The per-agent trade controller: chat decisions become trades, payments are credited, deadlines run, hand-offs and judgments are asked for.
import type { GistPartner, TradeDecision } from "../mind.ts";
import type { BotSnapshot, Position } from "../runtime-client.ts";
import { manhattan } from "../conversation/state.ts";
import type { BoardOffer, BoardPeer, TradeEndWhy } from "./board.ts";
import { checkTradeDecision, type DecisionSeen, isAskedGift } from "./checks.ts";
import type { TradeControllerDeps } from "./controller-deps.ts";
import { creditArrived, creditGains } from "./credits.ts";
import { writeGist } from "./gist-nudge.ts";
import { GiveBook } from "./gives.ts";
import { awaitKey, type HandoffEnd } from "./handoff.ts";
import { gaveOutside, type HandoffHost, giveIfCovered, handoffEnded, type Seen, startAgreed, startDeferred, tookInHandoff } from "./handoff-lifecycle.ts";
import { HandoffQueue } from "./handoff-queue.ts";
import { type OwedItem, sideText } from "./items.ts";
import { TradeLedgers } from "./ledgers.ts";
import { boardPeerHandlers } from "./peer.ts";
import { OwnProposals } from "./proposals.ts";
import { PartnerRecord } from "./partner-record.ts";
import { relationsBlock } from "./prompts.ts";
import { heldAwaits, heldOwed } from "./held.ts";
import { heldWindow } from "./record.ts";
import { recordTrade, settleOpenTrades } from "./trade-writes.ts";
import { AGREED_STATES, agreeTrade, cancelTrade, closedBeforeGiven, endedWhileWaiting, flipped, giverFirst, type HeldWindow, isOpen, newestTrade, owedItems, partnerPosition, repeatOfDone, restatedTrade, sameTerms } from "./trade.ts";
import { type Clocks, type GiveProgress, type ItemCount, MINUTE_MS, type Trade, type TradeState } from "./types.ts";
import { awaitsTheirSide, collectViewOf, creditHostOf, leftToGive, owedBy, payBackLeftMs, type TradeEventName } from "./views.ts";

export type { TradeControllerDeps } from "./controller-deps.ts";

type EventName = TradeEventName;

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

export class TradeController implements BoardPeer {
  private previous: Seen | null = null;
  private position: Position | null = null;
  private partners: ReadonlyMap<string, Position | null> = new Map();
  private readonly gives: GiveBook;
  private readonly queue: HandoffQueue;
  /** The earlier ledger, who stood near, and the collect fallback. */
  private readonly ledgers: TradeLedgers;
  /** My proposals: made, replaced, and agreed when paid or asked for. */
  private readonly proposals: OwnProposals;
  private readonly nobodyGave = new Set<string>();
  /** Trades whose giver said it cannot reach me: my wait for that trade walks to it, once. */
  private readonly cameDown = new Set<string>();
  /** Gives the agent is running now (from its start to its credit): the tick claims nothing for them, even once a stop cleared their `pending`. */
  private readonly running_ = new Set<string>();
  /** Agreed trades (oldest agreement first) that had no inventory to claim against when they were agreed: started by the next tick, from its bag. */
  private readonly startAtNextTick = new Set<string>();
  private ticksCounted = 0;
  private readonly running = new Set<Promise<void>>();
  private chain: Promise<unknown> = Promise.resolve();

  private readonly peer: BoardPeer;
  private readonly shown: PartnerRecord;
  /** The live state the hand-off steps and the views read: every member answers what the controller holds at the call. */
  private readonly host: HandoffHost;

  constructor(private readonly deps: TradeControllerDeps) {
    this.gives = new GiveBook(deps.now, deps.wallNow, deps.settings.payBackMinutes * MINUTE_MS);
    this.queue = new HandoffQueue(this.gives, deps.now, deps.takeHandoff);
    this.ledgers = new TradeLedgers({ gives: this.gives, find: (id) => this.find(id), recordReceived: (trade) => this.recordStep(trade, "received") });
    this.proposals = new OwnProposals({
      self: deps.self, board: deps.board, book: deps.book, gives: this.gives, ledgers: this.ledgers, log: deps.log,
      find: (id) => this.find(id), record: (trade, ...events) => this.record(trade, ...events), startAgreed: (trade, partner, at, carried) => startAgreed(this.host, trade, partner, at, carried),
    });
    this.peer = boardPeerHandlers({
      self: deps.self, wallNow: deps.wallNow, log: deps.log,
      find: (id) => this.find(id), tracked: (step) => this.tracked(step), record: (t, event) => this.record(t, event), startAgreed: (t, partner) => startAgreed(this.host, t, partner, this.clocks()),
      waiting: (id) => this.queue.awaiting.has(id), comeTo: (id) => void this.cameDown.add(id),
    });
    this.shown = new PartnerRecord({ book: deps.book, board: deps.board, gives: this.gives, log: deps.log, find: (id) => this.find(id), givePending: (id) => this.queue.givePending(id) || this.running_.has(id), heldWindow: () => this.heldWindow(), giveIfCovered: (t, partner) => giveIfCovered(this.host, t, partner) });
    this.host = {
      outsideGiveTarget: (partner, item, due) => this.outsideGiveTarget(partner, item, due),
      deps, gives: this.gives, queue: this.queue, ledgers: this.ledgers, shown: this.shown, startAtNextTick: this.startAtNextTick, nobodyGave: this.nobodyGave,
      partners: () => this.partners, position: () => this.position, previous: () => this.previous, find: (id) => this.find(id), heldWindow: () => this.heldWindow(),
      carriedNow: (snapshot) => this.carriedNow(snapshot), forgetSeen: () => this.forgetSeen(), partnerNear: (trade, at) => this.partnerNear(trade, at),
      record: (trade, ...events) => this.record(trade, ...events), recordStep: (trade, event, note) => this.recordStep(trade, event, note), tellEnd: (trade, why) => this.tellEnd(trade, why),
    };
    deps.board?.join(deps.self, this);
  }

  offerAccepted(tradeId: string, by: string): Promise<void> { return this.peer.offerAccepted(tradeId, by); }
  offerDeclined(tradeId: string, by: string, why: string): Promise<void> { return this.peer.offerDeclined(tradeId, by, why); }
  partnerEnded(tradeId: string, by: string, why: TradeEndWhy): Promise<void> { return this.peer.partnerEnded(tradeId, by, why); }
  receivedFor(tradeId: string): readonly ItemCount[] | null { return this.peer.receivedFor(tradeId); }
  cannotReach(tradeId: string, by: string): Promise<void> { return this.peer.cannotReach(tradeId, by); }

  /** An agreed trade I ended or broke: the partner bot of this brain is told, so its record ends the same trade. A proposal is answered through the board's offer instead. */
  private tellEnd(trade: Trade, why: TradeEndWhy): void {
    if (trade.state !== "proposed") this.deps.board?.tradeEnded(trade.id, this.deps.self, trade.partner, why);
  }

  /** Null when a propose or accept can become a trade, else the reason that is sent back to the chat tier once. */
  checkDecision(d: TradeDecision, speaker: string, snapshot: BotSnapshot): string | null {
    return checkTradeDecision({ decision: this.termsOf(d, d.action === "accept" ? this.offerFromPartner(speaker) : undefined), speaker, snapshot, trades: this.deps.book.trades(), maxOpenTrades: this.deps.settings.maxOpenTrades, reach: this.deps.settings.tradeReach, givenOutside: this.creditedTo(speaker), held: heldOwed(this.deps.book.trades(), this.heldWindow()) });
  }

  /**
   * The trade a propose or accept of the speaker's line re-states, else undefined (spec 2026-11-08-trading-p2-fixes D7b).
   * The speaker's agreed trades always count. The trade done just before the line was heard (`heardAt`) counts too, also after a refusal (its giver no longer holds the items),
   * but only with nothing open or offered by the speaker, as `onDecision` ignores a repeat: an accept of my own proposal agrees it.
   * `afterRefusal` (the checks refused the reply's trade): a trade of another partner counts too when the speaker has no trade or offer with me either way.
   */
  restatement(d: TradeDecision, speaker: string, o: { readonly afterRefusal: boolean; readonly heardAt?: number }): Trade | undefined {
    const nothingOpen = this.openWith(speaker) === undefined && this.offerFromPartner(speaker) === undefined;
    const others = o.afterRefusal && nothingOpen && this.deps.board?.offerFrom(this.deps.self, speaker) === undefined;
    return restatedTrade(this.deps.book.trades(), d, speaker, { others, done: nothingOpen, now: this.clocks().wallNow, ...(o.heardAt !== undefined && { heardAt: o.heardAt }) });
  }

  /** The proposal the partner (a bot of this brain) posted to me, still open. */
  private offerFromPartner(partner: string): BoardOffer | undefined {
    return this.deps.board?.offerFrom(partner, this.deps.self);
  }

  /** What an accept stands for: the proposer's terms, mirrored, when a bot of this brain proposed to me; else what my model wrote. */
  private termsOf(d: TradeDecision, offer: BoardOffer | undefined): TradeDecision {
    return offer === undefined ? d : { action: "accept", give: offer.get, get: offer.give, first: flipped(offer.first) };
  }

  /**
   * The chat decision's trade: a proposal, an agreement (the give starts when I go first) or an end. Answers the id of the trade it proposed or agreed, else null.
   * `seen`: what the model read when it decided: the time of the line it answers, and the id of the speaker's offer on the board then.
   */
  onDecision(d: TradeDecision, speaker: string, snapshot: BotSnapshot, seen?: DecisionSeen): Promise<string | null> {
    return this.exclusive(async () => {
      const at = this.clocks();
      const now = at.wallNow;
      // The inventory the next tick's gains are counted from, when no tick has been watching.
      this.previous ??= { inventory: snapshot.inventory, partners: new Map(snapshot.players.map((p) => [p.username, p.position])) };
      const mine = this.openWith(speaker);
      const local = this.deps.board?.isLocal(speaker) === true;
      const theirOffer = this.offerFromPartner(speaker);
      if (d.action === "accept" && seen !== undefined && theirOffer?.id !== seen.seenOfferId) {
        return this.note(null, `trade: ${speaker}'s offer changed since I read it (${seen.seenOfferId ?? "none"} -> ${theirOffer?.id ?? "none"}); my accept is not applied`);
      }
      const offer = d.action === "accept" ? theirOffer : undefined;
      const terms = this.termsOf(d, offer);
      const first = giverFirst(terms.give, terms.get, terms.first);
      if (first !== terms.first && (d.action === "propose" || d.action === "accept")) this.deps.log(`trade: a gift has one giver: first set to ${first}`);
      const deal = { self: this.deps.self, partner: speaker, give: terms.give, get: terms.get, first, now };
      const repeated = d.action !== "decline" && d.action !== "cancel" && mine === undefined && theirOffer === undefined ? repeatOfDone(this.deps.book.trades(), speaker, terms, now, seen?.heardAt) : undefined;
      if (repeated !== undefined) return this.note(null, `trade: a ${d.action} of ${speaker} ignored, it repeats ${repeated.id}, done ${Math.round((now - (repeated.endedAt ?? now)) / 1000)} s ago`);
      if (d.action === "propose") {
        const id = await this.proposals.propose(deal, at, mine, theirOffer, seen, this.carriedNow(snapshot));
        return isAskedGift(deal, seen, local) ? this.proposals.agreeAsked(id, speaker, at, this.carriedNow(snapshot)) : id;
      }
      if (d.action === "accept" && local && offer === undefined) {
        if (mine !== undefined) return this.note(null, `trade: an accept of ${speaker} ignored, ${mine.id} is still open and they proposed nothing to me`);
        // They offered in words only (or the offer is gone): my terms stand as a counter-offer, and their accept closes it on both sides.
        this.deps.log(`trade: no proposal from ${speaker} on the board; my terms are posted as a counter-offer`);
        return this.proposals.proposeAndPost(deal, at, this.carriedNow(snapshot), seen?.say);
      }
      if (d.action === "accept") {
        if (offer !== undefined && !sameTerms(d, terms)) this.deps.log(`trade: terms taken from ${speaker}'s offer: I give ${sideText(terms.give)}, I get ${sideText(terms.get)} (my reply said ${sideText(d.give)} for ${sideText(d.get)})`);
        const agreed = offer === undefined ? agreeTrade(mine?.state === "proposed" ? mine : null, deal) : { ...agreeTrade(null, deal), id: offer.id };
        // Before the record: saving an agreed trade takes its id off the board.
        if (offer !== undefined) this.deps.board?.accept(offer.id, this.deps.self);
        await this.record(agreed, "agreed");
        await startAgreed(this.host, agreed, speaker, at, this.carriedNow(snapshot));
        return agreed.id;
      }
      if (theirOffer !== undefined) this.deps.board?.decline(theirOffer.id, this.deps.self, d.action === "decline" ? "declined" : "cancelled");
      if (mine !== undefined) {
        await this.record(cancelTrade(mine, now, d.action === "decline" ? "I declined" : "I cancelled"), "cancelled");
        this.tellEnd(mine, d.action === "decline" ? "declined" : "cancelled");
      }
      return null;
    });
  }

  /** Logs why a decision is not applied, and answers `answer`: no trade id, or the open trade it stays with. */
  private note<T>(answer: T, line: string): T { this.deps.log(line); return answer; }

  /** A `give_item` the partner took, outside the trade's hand-off, counts toward my side of the oldest open trade with them whose side has the item (a proposed one too; capped at what is lacking); the side covered and agreed, the trade is given. */
  gaveOutside(partner: string, item: string, count: number): Promise<void> {
    return this.exclusive(() => gaveOutside(this.host, partner, item, count));
  }

  /**
   * The oldest trade with `partner` whose side of mine has `item` still to give, where a `give_item` outside the hand-off is counted:
   * a proposed one too, unless `due` (the give is asked to run now, so only a trade that is agreed counts).
   */
  outsideGiveTarget(partner: string, item: string, due: boolean): Trade | undefined {
    const states: readonly TradeState[] = due ? ["agreed", "they_gave"] : ["proposed", "agreed", "they_gave"];
    return this.deps.book.trades().filter((t) => same(t.partner, partner) && states.includes(t.state) && t.gaveAt === null && t.give.some((g) => g.item === item))
      .sort((a, b) => a.createdAt - b.createdAt)[0];
  }

  /** Whether a held trade with `partner` still awaits `item` from me or from them (`giveToHeldTrades` would count the give). */
  heldAwaits(partner: string, item: string): boolean { return heldAwaits(this.deps.book.trades(), partner, item, this.heldWindow()); }

  /** Saves a trade that moved by one event, adding `done` when that move finished it; an empty note takes `note`. */
  private recordStep(trade: Trade, event: EventName, note?: string): Promise<void> {
    const t = trade.note === "" && note !== undefined ? { ...trade, note } : trade;
    return this.record(t, event, ...(t.state === "done" ? (["done"] as const) : []));
  }

  /** What of my side the partner already took, per item: the credit of their open trade and the earlier gives still inside the window. */
  private creditedTo(partner: string): ReadonlyMap<string, number> {
    const credited = new Map<string, number>();
    const trade = this.openWith(partner);
    for (const [item, count] of trade === undefined ? [] : this.gives.givenOf(trade.id) ?? []) credited.set(item, count);
    if (trade === undefined || trade.state === "proposed") for (const e of this.ledgers.earlier.givesTo(partner, this.deps.now())) credited.set(e.item, (credited.get(e.item) ?? 0) + e.count);
    return credited;
  }

  /**
   * The latest inventory a tick saw; the chat `snapshot` only when no tick has watched. A chat snapshot is read before the
   * model call, 7-20 s before a decision: a payment dropped meanwhile is in the earlier ledger and in the bag, not in it.
   * With no snapshot at hand (a board accept) and no tick watching there is nothing to claim against: `[]` (review 2026-10-29 S1).
   */
  private carriedNow(snapshot?: BotSnapshot): BotSnapshot["inventory"] {
    return this.previous?.inventory ?? snapshot?.inventory ?? [];
  }

  /** A hand-off's give was partly or fully taken: what the partner took counts toward my side, so a retake gives only what is left. */
  tookInHandoff(tradeId: string, taken: readonly ItemCount[]): Promise<void> {
    return this.exclusive(() => tookInHandoff(this.host, tradeId, taken));
  }

  /** The items of my side the partner's own record shows received that I have not credited; null when the partner is no character of this brain or holds no such trade. */
  unclaimedByPartner(tradeId: string): ItemCount[] | null { return this.shown.unclaimed(tradeId); }

  /** The agent starts (true) or ends (false) running my give for the trade. */
  giveRunning(tradeId: string, on: boolean): void { if (on) this.running_.add(tradeId); else this.running_.delete(tradeId); }

  /** The giver said it cannot reach me for this trade: true once, for the wait to walk to it. */
  askedToCome(tradeId: string): boolean { return this.cameDown.delete(tradeId); }

  /** What of my side is still to give for a trade: null when it is not open or my side was given (`views.ts`). */
  leftToGive(tradeId: string): ItemCount[] | null { return leftToGive(this.host, tradeId); }

  /** My side not yet given of every agreed trade, a payment held for an ended trade too (`views.ts`). */
  owed(): OwedItem[] { return owedBy(this.host); }

  /** How long a payment held for an ended trade counts, as of now. */
  private heldWindow(): HeldWindow { return heldWindow(this.deps.wallNow(), this.deps.book.scoring); }

  /** Both clocks, read together. */
  private clocks(): Clocks { return { now: this.deps.now(), wallNow: this.deps.wallNow() }; }

  /** How long my give for the trade may still run before the pay-back clock ends the trade; 0 for a trade that is not open (`views.ts`). */
  payBackLeftMs(tradeId: string): number { return payBackLeftMs(this.host, tradeId); }

  /**
   * How a trade closed before my side was given (its state, or "gone" when the book has no such trade); null while it
   * is open, or once my side was given (done, or a give made outside the hand-off).
   */
  closedAs(tradeId: string): string | null { return closedBeforeGiven(this.find(tradeId)); }

  /** A hand-off found nothing left to give: the agent ended it, so it is no longer pending (no retake clock). */
  handoffSkipped(tradeId: string): void { this.queue.pending.delete(tradeId); }

  /** Whether their payment is still to come for a trade (the wait for their side ends otherwise; `views.ts`). */
  awaits(tradeId: string): boolean { return awaitsTheirSide(this.host, tradeId); }

  /** How a trade ended when the wait for their side is over: its state and note, "gone" when the book has no such trade; null while it is open or once it is done. */
  awaitOver(tradeId: string): string | null { return endedWhileWaiting(this.find(tradeId)); }

  /** A wait for their side ended: dropped (a stop, a shelter) it is taken again after a while; any other end is final. */
  awaitEnded(tradeId: string, outcome: HandoffEnd["outcome"]): void {
    this.queue.awaitOver(tradeId);
    this.cameDown.delete(tradeId);
    if (outcome !== "dropped") {
      this.ledgers.collectEnded(tradeId); // a wait that ended reads the bag once, as a collect does: what reached it unseen is credited
      return;
    }
    this.queue.awaitDropped(tradeId);
  }

  /** A partner's line (`at`: its wall time, as the agent heard it): after agreement it starts the short watch for their payment (the collect fallback). */
  heardLine(speaker: string, at: number, distance: number | null): void {
    this.ledgers.heard(this.deps.book.trades(), speaker, { now: this.deps.now(), wallNow: at }, distance, this.deps.persona.settings.conversation.openingDistance);
  }

  /** The agent's poll tick: credits gains, runs the deadlines, takes due hand-offs. Never waits on a model. */
  tick(snapshot: BotSnapshot, ownStepYields: ReadonlySet<string>, signal: AbortSignal, ownWork = false): Promise<void> {
    return this.exclusive(async () => {
      const at = this.clocks();
      const previous = this.previous;
      this.partners = new Map(snapshot.players.map((p) => [p.username, p.position]));
      this.previous = { inventory: snapshot.inventory, partners: this.partners };
      this.position = snapshot.position;
      this.ledgers.noteTick(snapshot, this.deps.settings.handoffDistance, at.now);
      await startDeferred(this.host, previous, snapshot, at);
      if (previous !== null) {
        await creditGains(creditHostOf(this.host), snapshot, previous, ownStepYields, at, ownWork);
        this.ticksCounted += 1; // after the gains were counted: a tick that threw before counted none
      } else this.ledgers.rebase(this.deps.book.trades(), snapshot.inventory);
      await this.proposals.agreePaid(snapshot.inventory, at);
      await creditArrived(creditHostOf(this.host), snapshot.inventory, ownStepYields, at);
      await settleOpenTrades(this.host, at.wallNow);
      await this.shown.claimAll();
      this.ledgers.startCollects(collectViewOf(this.host), at.now, this.deps.takeHandoff);
      if (!this.busy()) this.previous = null;
    });
  }

  /** Whether the agent should tick: a trade is open, one broken by them may still be paid late, a hand-off is waiting. */
  busy(withWindow = true): boolean {
    const wallNow = this.deps.wallNow();
    const waiting = this.deps.book.trades().some((t) => isOpen(t) || (t.state === "broken" && t.brokenBy === "them" && wallNow - (t.endedAt ?? wallNow) < this.deps.settings.offersForgetMinutes * MINUTE_MS && owedItems(t).length > 0));
    return waiting || (withWindow && this.ledgers.watching(this.deps.now())) || this.queue.pending.size > 0 || this.running.size > 0;
  }

  /** Busy for a player's window alone (no trade or hand-off): the agent may poll slowly. */
  onlyWatching(): boolean { return this.busy() && !this.busy(false); }

  /** No baseline: the next tick counts no gain. The agent's look calls it whenever no tick started on the yields it dropped. */
  forgetSeen(): void { this.previous = null; }

  /** How many ticks ran with a baseline (counting gains); a tick after `forgetSeen` does not raise it. */
  countedTicks(): number { return this.ticksCounted; }

  /** A hand-off ended: a give is counted given, or failed (items gone at once; otherwise tried once more with the partner near, a not-taken one also after a wait), or waits on a busy recipient (no failure counted; retaken after a wait with the partner near). */
  handoffEnded(tradeId: string, outcome: Exclude<HandoffEnd["outcome"], "dropped">, detail: string): Promise<void> {
    return this.exclusive(() => handoffEnded(this.host, tradeId, outcome, detail));
  }

  /** The agent says which hand-offs are on its stack: one asked for and gone from it (a stop cleared it) is dropped. */
  reconcileHandoffs(onStack: ReadonlySet<string>): void {
    for (const id of [...this.queue.pending.keys()]) if (!onStack.has(id)) this.handoffDropped(id);
    for (const id of [...this.queue.awaiting]) if (!onStack.has(awaitKey(id))) this.awaitEnded(id, "dropped");
  }

  /** A hand-off was dropped (a night shelter, a stop): the trade stays due and the give is taken again after a while. */
  handoffDropped(tradeId: string): void {
    this.queue.dropped(tradeId);
  }

  /** The gist's nudge of the score of each other member (one write with what they said they have or need). */
  onConversationEnded(partners: readonly GistPartner[]): Promise<void> {
    return this.exclusive(() => writeGist(this.deps.book, partners, this.deps.wallNow(), this.deps.settings.offersForgetMinutes, this.deps.journal));
  }

  /** The relations block of a chat request: the records of those in it, trades nobody started, and what the objective lacks. */
  block(partners: readonly string[], lacks: readonly string[]): string {
    const idle = [...this.nobodyGave].map((id) => this.find(id)).filter((t): t is Trade => t !== undefined)
      .map((t) => `Nobody has given yet on your agreed trade with ${t.partner} (you give ${sideText(t.give) || "nothing"}, they give ${sideText(t.get) || "nothing"}): you may go first, ask them to, or cancel it.`);
    return relationsBlock([...this.deps.book.summaries(partners, (id) => this.giveProgress(id)), ...idle], lacks);
  }

  /** Resolves when the background steps started so far are over (the agent's shutdown, the tests). */
  async settled(): Promise<void> {
    while (this.running.size > 0) await Promise.all([...this.running]);
  }

  /** Controller steps run one after the other: a tick never reads a trade another step is changing. */
  private exclusive<T>(step: () => Promise<T>): Promise<T> {
    const run = this.chain.then(step);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** A controller step the board asked for: exclusive like the rest, and counted so `settled()` and `busy()` see it. */
  private tracked(step: () => Promise<void>): Promise<void> {
    const task = this.exclusive(step);
    this.running.add(task);
    void task.finally(() => this.running.delete(task)).catch(() => undefined);
    return task;
  }

  private find(tradeId: string): Trade | undefined { return this.deps.book.trades().find((t) => t.id === tradeId); }

  /** The newest trade with that partner proposed at or after `since`; a read, nothing is written. */
  latestWith(partner: string, since: number): Trade | null {
    return newestTrade(this.deps.book.trades(), (t) => same(t.partner, partner) && t.createdAt >= since);
  }

  /** The newest trade with any partner created at or after `since` that is agreed or further; a read, nothing is written. */
  agreedSince(since: number): Trade | null {
    return newestTrade(this.deps.book.trades(), (t) => t.createdAt >= since && AGREED_STATES.has(t.state));
  }

  /** My open trade with the partner, if any. */
  openWith(partner: string): Trade | undefined { return this.deps.book.trades().find((t) => isOpen(t) && same(t.partner, partner)); }

  /** Saves the trade in its partner's record (counting an end into the facts) and journals the events (`trade-writes.ts`). */
  private record(given: Trade, ...events: EventName[]): Promise<void> { return recordTrade(this.host, given, ...events); }

  /** The partner stands within opening distance of `at` (a failed or busy give is retried only then). */
  private partnerNear(t: Trade, at: Position | null): boolean {
    const there = partnerPosition(this.partners, t.partner);
    return at !== null && there !== null && manhattan(at, there) <= this.deps.persona.settings.conversation.openingDistance;
  }

  /** What of my side an open trade has given and why its give waits, for the line the model reads; undefined for a trade that is not open. */
  giveProgress(tradeId: string): GiveProgress | undefined {
    const trade = this.find(tradeId);
    if (trade === undefined || !isOpen(trade)) return undefined;
    const idle = !this.queue.givePending(tradeId); // a give that runs is handed over: nothing waits
    return this.gives.progress(tradeId, idle, !this.partnerNear(trade, this.position), this.deps.persona.settings.conversation.openingDistance);
  }
}
