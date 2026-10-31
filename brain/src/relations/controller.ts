// The per-agent trade controller: chat decisions become trades, payments are credited, deadlines run, hand-offs and judgments are asked for.
import type { GistPartner, TradeDecision } from "../mind.ts";
import type { Persona } from "../persona.ts";
import type { BotSnapshot, Position } from "../runtime-client.ts";
import { manhattan } from "../conversation/state.ts";
import type { BoardOffer, BoardPeer, TradeBoard } from "./board.ts";
import type { RelationBook } from "./book.ts";
import { checkTradeDecision, type DecisionSeen, givesCarriedOver, termsDifferFromWords, whyProposalDropped } from "./checks.ts";
import { CollectFallback, type CollectView } from "./collects.ts";
import { EARLIER_GIVE_MS, EarlierLedger, NearLedger } from "./earlier.ts";
import { awaitKey, type Handoff, type HandoffEnd } from "./handoff.ts";
import { sideText } from "./items.ts";
import { relationsBlock } from "./prompts.ts";
import { forgetOldSaid, withSaid, withTrade } from "./record.ts";
import { newScoredRows, withScoreEvent } from "./score.ts";
import { scoreEndedTrade } from "./trade-score.ts";
import { AGREED_STATES, agreeTrade, attributeGains, cancelTrade, creditTrade, failTrade, flipped, inventoryGains, isOpen, markGave, newestTrade, owedItems, partnerPosition, proposeTrade, repeatOfDone, sameDealTerms, sameTerms, settleTrade } from "./trade.ts";
import { type GiveProgress, type ItemCount, MINUTE_MS, type RelationEvent, type Trade, type TradeEvent, type TradeSettings, type TradeState } from "./types.ts";

/** A hand-off dropped by a shelter or a stop is taken again after this long. */
const RETAKE_AFTER_MS = 30_000;
/** A give is tried this many times (the second only with the partner in talk range) before it counts as failed. */
const GIVE_ATTEMPTS = 2;
export interface TradeControllerDeps {
  readonly self: string;
  readonly persona: Persona;
  readonly book: RelationBook;
  readonly settings: TradeSettings;
  readonly now: () => number;
  /** The agent pushes the routine objective for this hand-off. */
  readonly takeHandoff: (h: Handoff) => void;
  readonly journal: (e: TradeEvent | RelationEvent) => void;
  readonly log: (line: string) => void;
  /** The brain's trade board: a trade with another bot of this brain is made on the proposer's terms. Absent: every partner is treated as outside the brain. */
  readonly board?: TradeBoard;
}

type EventName = TradeEvent["event"];

/** What the last tick saw: my inventory and where each player stood. */
interface Seen { readonly inventory: BotSnapshot["inventory"]; readonly partners: ReadonlyMap<string, Position | null> }


const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const EVENT_OF_STATE: Record<TradeState, EventName> = { proposed: "proposed", agreed: "agreed", i_gave: "gave", they_gave: "received", done: "done", broken: "broken", cancelled: "cancelled" };

export class TradeController implements BoardPeer {
  private previous: Seen | null = null;
  private position: Position | null = null;
  private partners: ReadonlyMap<string, Position | null> = new Map();
  /** Hand-offs the agent was asked for and has not ended, by trade id. */
  private readonly pending = new Map<string, "give" | "collect">();
  private readonly giveFailures = new Map<string, number>();
  private readonly droppedAt = new Map<string, number>();
  /** Trade id -> when its give was handed to the agent: a give pending longer than the pay-back time is stuck (queued behind an order), and no longer holds the deadline back. */
  private readonly giveTakenAt = new Map<string, number>();
  /** Trades whose wait for their side was taken and not dropped (a wait that ended is not taken again). */
  private readonly awaited = new Set<string>();
  /** Trades whose wait is on the agent's stack now. */
  private readonly awaiting = new Set<string>();
  private readonly near = new NearLedger();
  /** Trade id -> item -> count of my side given by a `give_item` outside the hand-off (memory only: a restart loses it). */
  private readonly givenOutside = new Map<string, Map<string, number>>();
  /** Gives a partner took, and payments picked up while they talked, with no trade yet: kept for the next trade with them. */
  private readonly earlier = new EarlierLedger();
  /** Per proposal: the earlier gives it took from the ledger, which go back there when it ends unagreed. */
  private readonly fromLedger = new Map<string, ItemCount[]>();
  /** The collect fallback and what each agreed trade's bag held at agreement (items that arrived unseen are credited from the inventory). */
  private readonly collects = new CollectFallback();
  private readonly nobodyGave = new Set<string>();
  private readonly running = new Set<Promise<void>>();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: TradeControllerDeps) {
    deps.board?.join(deps.self, this);
  }

  /** Null when a propose or accept can become a trade, else the reason that is sent back to the chat tier once. */
  checkDecision(d: TradeDecision, speaker: string, snapshot: BotSnapshot): string | null {
    return checkTradeDecision({ decision: this.termsOf(d, d.action === "accept" ? this.offerFromPartner(speaker) : undefined), speaker, snapshot, trades: this.deps.book.trades(), maxOpenTrades: this.deps.settings.maxOpenTrades, reach: this.deps.settings.tradeReach, givenOutside: this.creditedTo(speaker) });
  }

  /** The proposal the partner (a bot of this brain) posted to me, still open. */
  private offerFromPartner(partner: string): BoardOffer | undefined {
    return this.deps.board?.offerFrom(partner, this.deps.self);
  }

  /** What an accept stands for: the proposer's terms, mirrored, when a bot of this brain proposed to me; else what my model wrote. */
  private termsOf(d: TradeDecision, offer: BoardOffer | undefined): TradeDecision {
    return offer === undefined ? d : { action: "accept", give: offer.get, get: offer.give, first: flipped(offer.first) };
  }

  /** A bot of this brain I propose or counter to: the proposal goes on the board for the partner's accept. */
  private post(trade: Trade): void {
    const { board } = this.deps;
    if (board?.isLocal(trade.partner) !== true) return;
    board.post({ id: trade.id, proposer: this.deps.self, partner: trade.partner, give: trade.give, get: trade.get, first: trade.first, postedAt: trade.createdAt });
  }

  /** The partner accepted the proposal I posted: my record moves to agreed on the terms it already holds. */
  offerAccepted(tradeId: string, by: string): Promise<void> {
    return this.tracked(async () => {
      const trade = this.find(tradeId);
      if (trade === undefined || trade.state !== "proposed") return void this.deps.log(`trade: ${by} accepted ${tradeId}, which is no longer a proposal of mine`);
      const now = this.deps.now();
      const agreed = agreeTrade(trade, { self: this.deps.self, partner: trade.partner, give: trade.give, get: trade.get, first: trade.first, now });
      await this.record(agreed, "agreed");
      await this.startAgreed(agreed, trade.partner, now);
    });
  }

  /** A trade just agreed: earlier gives and payments are claimed, then my side is given at once if covered, or handed to the agent if due. */
  private async startAgreed(agreed: Trade, partner: string, now: number, carried?: BotSnapshot["inventory"]): Promise<void> {
    const current = await this.claimEarlier(agreed, now, carried);
    const seen = this.previous?.inventory ?? carried;
    if (seen !== undefined) this.collects.arrivals.start(current, seen);
    if (await this.giveIfCovered(current, partner)) return;
    if (this.isGiveDue(current, now, null)) this.takeGive(current);
  }

  /** The partner declined the proposal I posted: my record is cancelled. */
  offerDeclined(tradeId: string, by: string, why: string): Promise<void> {
    return this.tracked(async () => {
      const trade = this.find(tradeId);
      if (trade === undefined || trade.state !== "proposed") return;
      await this.record(cancelTrade(trade, this.deps.now(), `${by} ${why}`), "cancelled");
    });
  }

  /**
   * The chat decision's trade: a proposal, an agreement (the give starts when I go first) or an end. Answers the id of the trade it proposed or agreed, else null.
   * `seen`: what the model read when it decided: the time of the line it answers, and the id of the speaker's offer on the board then.
   */
  onDecision(d: TradeDecision, speaker: string, snapshot: BotSnapshot, seen?: DecisionSeen): Promise<string | null> {
    return this.exclusive(async () => {
      const now = this.deps.now();
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
      const deal = { self: this.deps.self, partner: speaker, give: terms.give, get: terms.get, first: terms.first, now };
      const repeated = d.action !== "decline" && d.action !== "cancel" && mine === undefined && theirOffer === undefined ? repeatOfDone(this.deps.book.trades(), speaker, terms, now) : undefined;
      if (repeated !== undefined) return this.note(null, `trade: a ${d.action} of ${speaker} ignored, it repeats ${repeated.id}, done ${Math.round((now - (repeated.endedAt ?? now)) / 1000)} s ago`);
      if (d.action === "propose") return this.onPropose(deal, mine, theirOffer, seen, this.carriedNow(snapshot));
      if (d.action === "accept" && local && offer === undefined) {
        if (mine !== undefined) return this.note(null, `trade: an accept of ${speaker} ignored, ${mine.id} is still open and they proposed nothing to me`);
        // They offered in words only (or the offer is gone): my terms stand as a counter-offer, and their accept closes it on both sides.
        this.deps.log(`trade: no proposal from ${speaker} on the board; my terms are posted as a counter-offer`);
        return this.proposeAndPost(deal, now, this.carriedNow(snapshot), seen?.say);
      }
      if (d.action === "accept") {
        if (offer !== undefined && !sameTerms(d, terms)) this.deps.log(`trade: terms taken from ${speaker}'s offer: I give ${sideText(terms.give)}, I get ${sideText(terms.get)} (my reply said ${sideText(d.give)} for ${sideText(d.get)})`);
        const agreed = offer === undefined ? agreeTrade(mine?.state === "proposed" ? mine : null, deal) : { ...agreeTrade(null, deal), id: offer.id };
        // Before the record: saving an agreed trade takes its id off the board.
        if (offer !== undefined) this.deps.board?.accept(offer.id, this.deps.self);
        await this.record(agreed, "agreed");
        await this.startAgreed(agreed, speaker, now, this.carriedNow(snapshot));
        return agreed.id;
      }
      if (theirOffer !== undefined) this.deps.board?.decline(theirOffer.id, this.deps.self, d.action === "decline" ? "declined" : "cancelled");
      if (mine !== undefined) await this.record(cancelTrade(mine, now, d.action === "decline" ? "I declined" : "I cancelled"), "cancelled");
      return null;
    });
  }

  /** Logs why a decision is not applied, and answers `answer`: no trade id, or the open trade it stays with. */
  private note<T>(answer: T, line: string): T { this.deps.log(line); return answer; }

  /** A propose: replaces my open proposal to them (a restated one stays), and counters their offer when I read it first (`seen`, bot partners). */
  private async onPropose(deal: Parameters<typeof proposeTrade>[0], mine: Trade | undefined, theirOffer: BoardOffer | undefined, seen: DecisionSeen | undefined, carried: BotSnapshot["inventory"]): Promise<string | null> {
    const { partner: speaker, now } = deal;
    const { board, self } = this.deps;
    const dropped = whyProposalDropped({ speaker, mine, ownOfferId: board?.offerFrom(self, speaker)?.id, local: board?.isLocal(speaker) === true, theirOffer, heardAt: seen?.heardAt, seenOfferId: seen?.seenOfferId });
    if (dropped !== null) return this.note(null, dropped);
    if (mine !== undefined && sameDealTerms(mine, deal) && mine.first === deal.first) return this.note(mine.id, `trade: my proposal to ${speaker} repeats ${mine.id}, which stays open`);
    const kept = mine === undefined ? [] : givesCarriedOver(this.givenOutside.get(mine.id), this.fromLedger.get(mine.id));
    if (mine !== undefined) await this.record(cancelTrade(mine, now, "replaced"), "cancelled");
    if (theirOffer !== undefined) {
      board?.decline(theirOffer.id, self, "countered");
      this.deps.log(`trade: counter-offer to ${speaker}: I give ${sideText(deal.give)}, I get ${sideText(deal.get)}; their ${theirOffer.id} declined`);
    }
    const id = await this.proposeAndPost(deal, now, carried, seen?.say);
    const fresh = this.find(id);
    if (fresh !== undefined) for (const [item, count] of kept) this.creditGiven(fresh, item, count);
    return id;
  }

  /** A new proposal of mine, posted on the board when the partner is a bot of this brain. */
  private async proposeAndPost(deal: Parameters<typeof proposeTrade>[0], now: number, carried: BotSnapshot["inventory"], said?: string): Promise<string> {
    for (const line of termsDifferFromWords(said, [...deal.give, ...deal.get])) this.deps.log(line);
    const proposed = proposeTrade(deal);
    await this.record(proposed, "proposed");
    this.post(proposed);
    await this.claimEarlier(proposed, now, carried);
    // A payment dropped while the model was still deciding is already kept: the proposal it answers is agreed as it is posted.
    await this.agreePaidProposals(carried, now);
    return proposed.id;
  }

  /** A `give_item` the partner took, outside the trade's hand-off, counts toward my side of the oldest open trade with them whose side has the item (a proposed one too; capped at what is lacking); the side covered and agreed, the trade is given. */
  gaveOutside(partner: string, item: string, count: number): Promise<void> {
    return this.exclusive(async () => {
      const trade = this.deps.book.trades().filter((t) => same(t.partner, partner) && (t.state === "proposed" || t.state === "agreed" || t.state === "they_gave") && t.gaveAt === null && t.give.some((g) => g.item === item)) .sort((a, b) => a.createdAt - b.createdAt)[0];
      if (trade === undefined) {
        this.earlier.gave(partner, item, count, this.deps.now());
        return void this.deps.log(`trade: ${count} ${item} given to ${partner} outside a hand-off matches no open trade of mine; not counted yet, kept for a trade proposed within ${EARLIER_GIVE_MS / MINUTE_MS} min`);
      }
      this.creditGiven(trade, item, count);
      await this.giveIfCovered(trade, partner);
    });
  }

  /** My side was all given before it was due: the trade is given at once (done when they gave too), with no hand-off. Proposed trades wait for the agreement. */
  private async giveIfCovered(trade: Trade, partner: string): Promise<boolean> {
    const due = trade.state === "agreed" || trade.state === "they_gave";
    if (!due || trade.give.length === 0 || (this.leftToGiveOf(trade) ?? []).length > 0) return false;
    this.givenOutside.delete(trade.id);
    const gave = markGave(trade, this.deps.now());
    await this.recordStep(gave, "gave", `gave ${sideText(trade.give)} to ${partner}, outside the hand-off`);
    return true;
  }

  /** Saves a trade that moved by one event, adding `done` when that move finished it; an empty note takes `note`. */
  private recordStep(trade: Trade, event: EventName, note?: string): Promise<void> {
    const t = trade.note === "" && note !== undefined ? { ...trade, note } : trade;
    return this.record(t, event, ...(t.state === "done" ? (["done"] as const) : []));
  }

  /** What of my side the partner already took, per item: the credit of their open trade and the earlier gives still inside the window. */
  private creditedTo(partner: string): ReadonlyMap<string, number> {
    const credited = new Map<string, number>();
    const trade = this.openWith(partner);
    for (const [item, count] of trade === undefined ? [] : this.givenOutside.get(trade.id) ?? []) credited.set(item, count);
    if (trade === undefined || trade.state === "proposed") for (const e of this.earlier.givesTo(partner, this.deps.now())) credited.set(e.item, (credited.get(e.item) ?? 0) + e.count);
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

  /** A trade just made takes the partner's earlier gives still inside the window, once (capped at its side); an agreed one also the payment picked up before the agreement. Returns the trade as it stands then. */
  private async claimEarlier(trade: Trade, now: number, carried = this.carriedNow()): Promise<Trade> {
    const claimed = this.earlier.claimGives(trade, now);
    for (const e of claimed) this.creditGiven(trade, e.item, e.count);
    if (trade.state === "proposed" && claimed.length > 0) this.fromLedger.set(trade.id, claimed);
    const { trade: next, used } = creditTrade(trade, trade.state === "agreed" ? this.earlier.claimGains(trade, carried, now) : [], now);
    if (used.length > 0) await this.recordStep(next, "received");
    return next;
  }

  /** A hand-off's give was partly or fully taken: what the partner took counts toward my side, so a retake gives only what is left. */
  tookInHandoff(tradeId: string, taken: readonly ItemCount[]): Promise<void> {
    return this.exclusive(async () => {
      const trade = this.find(tradeId);
      if (trade === undefined || !isOpen(trade) || trade.gaveAt !== null) return;
      for (const { item, count } of taken) this.creditGiven(trade, item, count);
    });
  }

  /** What of my side is still to give for a trade: null when it is not open or my side was given. */
  leftToGive(tradeId: string): ItemCount[] | null {
    const trade = this.find(tradeId);
    return trade === undefined ? null : this.leftToGiveOf(trade);
  }

  /**
   * How a trade closed before my side was given (its state, or "gone" when the book has no such trade); null while it
   * is open, or once my side was given (done, or a give made outside the hand-off).
   */
  closedAs(tradeId: string): string | null {
    const trade = this.find(tradeId);
    if (trade === undefined) return "gone";
    return isOpen(trade) || trade.state === "done" || trade.gaveAt !== null ? null : trade.state;
  }

  /** A hand-off found nothing left to give: the agent ended it, so it is no longer pending (no retake clock). */
  handoffSkipped(tradeId: string): void { this.pending.delete(tradeId); }

  /** Whether their payment is still to come for a trade: it is agreed and nothing came yet (the wait for their side ends otherwise). */
  awaits(tradeId: string): boolean {
    const trade = this.find(tradeId);
    return trade !== undefined && trade.state === "agreed" && trade.received.length === 0 && owedItems(trade).length > 0;
  }

  /** A wait for their side ended: dropped (a stop, a shelter) it is taken again after a while; any other end is final. */
  awaitEnded(tradeId: string, outcome: HandoffEnd["outcome"]): void {
    this.awaiting.delete(tradeId);
    if (outcome !== "dropped") return;
    this.awaited.delete(tradeId);
    this.droppedAt.set(awaitKey(tradeId), this.deps.now());
  }

  /** Adds items the partner took to what is credited for the trade, capped at the side. */
  private creditGiven(trade: Trade, item: string, count: number): void {
    const wanted = trade.give.find((g) => g.item === item)?.count ?? 0;
    const given = this.givenOutside.get(trade.id) ?? new Map<string, number>();
    given.set(item, Math.min(wanted, (given.get(item) ?? 0) + Math.max(0, count)));
    this.givenOutside.set(trade.id, given);
  }

  private leftToGiveOf(t: Trade): ItemCount[] | null {
    if (!isOpen(t) || t.gaveAt !== null) return null;
    const given = this.givenOutside.get(t.id);
    return t.give.map((g) => ({ item: g.item, count: g.count - (given?.get(g.item) ?? 0) })).filter((g) => g.count > 0);
  }

  /** A partner's line: after agreement it starts the short watch for their payment (the collect fallback). */
  heardLine(speaker: string, at: number, distance: number | null): void {
    if (distance !== null && distance <= this.deps.persona.settings.conversation.openingDistance) this.earlier.heard(speaker, at);
    this.collects.heard(this.deps.book.trades(), speaker, at);
  }

  /** The agent's poll tick: credits gains, runs the deadlines, takes due hand-offs. Never waits on a model. */
  tick(snapshot: BotSnapshot, ownStepYields: ReadonlySet<string>, signal: AbortSignal): Promise<void> {
    return this.exclusive(async () => {
      const now = this.deps.now();
      const previous = this.previous;
      this.partners = new Map(snapshot.players.map((p) => [p.username, p.position]));
      this.previous = { inventory: snapshot.inventory, partners: this.partners };
      this.position = snapshot.position;
      this.near.note(snapshot, this.deps.settings.handoffDistance, now);
      if (previous !== null) await this.creditGains(snapshot, previous, ownStepYields, now);
      else this.collects.arrivals.rebase(this.deps.book.trades(), snapshot.inventory);
      await this.agreePaidProposals(snapshot.inventory, now);
      await this.creditArrived(snapshot.inventory, ownStepYields, now);
      await this.settleOpen(now);
      this.collects.start(this.collectView(), now, this.deps.takeHandoff);
      if (!this.busy()) this.previous = null;
    });
  }

  /** Whether the agent should tick: a trade is open, one broken by them may still be paid late, a hand-off is waiting. */
  busy(withWindow = true): boolean {
    const now = this.deps.now();
    const waiting = this.deps.book.trades().some((t) => isOpen(t) || (t.state === "broken" && t.brokenBy === "them" && now - (t.endedAt ?? now) < this.deps.settings.offersForgetMinutes * MINUTE_MS && owedItems(t).length > 0));
    return waiting || (withWindow && this.earlier.watching(now)) || this.pending.size > 0 || this.running.size > 0;
  }

  /** Busy for a player's window alone (no trade or hand-off): the agent may poll slowly. */
  onlyWatching(): boolean { return this.busy() && !this.busy(false); }

  /** No baseline: the next tick counts no gain. The agent's look calls it whenever no tick started on the yields it dropped. */
  forgetSeen(): void { this.previous = null; }

  /** A hand-off ended: a give is counted given, or failed (items gone at once; otherwise tried once more with the partner near, a not-taken one also after a wait). */
  handoffEnded(tradeId: string, outcome: Exclude<HandoffEnd["outcome"], "dropped">, detail: string): Promise<void> {
    return this.exclusive(async () => {
      const kind = this.pending.get(tradeId) ?? "give";
      this.pending.delete(tradeId);
      const trade = this.find(tradeId);
      if (trade === undefined || !isOpen(trade)) return;
      const now = this.deps.now();
      if (kind === "collect") {
        this.collects.collectEnded(tradeId);
        this.deps.log(`trade: collect for ${tradeId} ${outcome}: ${detail}`);
      } else if (outcome === "done") {
        const gave = markGave(trade, now);
        await this.recordStep(gave, "gave", detail);
      } else if (outcome === "items_gone") {
        await this.record(failTrade(trade, now, detail), "broken");
      } else {
        const failures = (this.giveFailures.get(tradeId) ?? 0) + 1;
        this.giveFailures.set(tradeId, failures);
        const why = outcome === "not_taken" ? `${trade.partner} did not take ${sideText(this.leftToGiveOf(trade) ?? trade.give)} (${GIVE_ATTEMPTS} tries); I kept them` : detail;
        if (failures >= GIVE_ATTEMPTS) await this.record(failTrade(trade, now, why), "broken");
        else this.deps.log(`trade: the give for ${tradeId} ${outcome === "not_taken" ? "was not taken" : "failed"} (${detail}); it stays due`);
        if (outcome === "not_taken") this.droppedAt.set(tradeId, now);
      }
    });
  }

  /** The agent says which hand-offs are on its stack: one asked for and gone from it (a stop cleared it) is dropped. */
  reconcileHandoffs(onStack: ReadonlySet<string>): void {
    for (const id of [...this.pending.keys()]) if (!onStack.has(id)) this.handoffDropped(id);
    for (const id of [...this.awaiting]) if (!onStack.has(awaitKey(id))) this.awaitEnded(id, "dropped");
  }

  /** A hand-off was dropped (a night shelter, a stop): the trade stays due and the give is taken again after a while. */
  handoffDropped(tradeId: string): void {
    this.pending.delete(tradeId);
    this.droppedAt.set(tradeId, this.deps.now());
  }

  /** The gist's nudge of the score of each other member (one write with what they said they have or need). */
  onConversationEnded(partners: readonly GistPartner[]): Promise<void> {
    return this.exclusive(async () => {
      const now = this.deps.now();
      for (const p of partners) {
        const { nudge } = p;
        if (nudge === null && p.has.length === 0 && p.needs.length === 0) continue;
        const { book, settings } = this.deps;
        let rows: RelationEvent[] = [];
        await book.update(p.name, (r) => {
          const said = forgetOldSaid(withSaid(r, p.has, p.needs, now), now, settings.offersForgetMinutes);
          const next = nudge === null ? said : withScoreEvent(said, { kind: "nudge", nudge: nudge.value, why: nudge.why }, now, book.scoring);
          rows = newScoredRows(r, next);
          return next;
        });
        for (const row of rows) this.deps.journal(row);
      }
    });
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

  /** Saves the trade in its partner's record (counting an end into the facts) and journals the events. */
  private async record(trade: Trade, ...events: EventName[]): Promise<void> {
    const ended = !isOpen(trade);
    if (trade.state !== "proposed") this.deps.board?.withdraw(trade.id);
    // An end and its score are one write: a replayed end cannot be scored twice, a crash cannot store the end without its score.
    if (ended) {
      for (const row of await scoreEndedTrade(this.deps.book, trade, this.deps.now())) this.deps.journal(row);
    } else {
      await this.deps.book.update(trade.partner, (r) => withTrade(r, trade));
    }
    for (const event of events) this.deps.journal({ kind: "trade", event, partner: trade.partner, tradeId: trade.id, give: trade.give, get: trade.get, first: trade.first, note: trade.note });
    if (!ended) return;
    // A proposal that ended unagreed gives the ledger's gives it took back (the window restarts now: the original time is not kept).
    if (trade.state === "cancelled" && trade.agreedAt === null) for (const e of this.fromLedger.get(trade.id) ?? []) this.earlier.gave(trade.partner, e.item, e.count, this.deps.now());
    for (const held of [this.nobodyGave, this.givenOutside, this.giveTakenAt, this.fromLedger]) held.delete(trade.id);
    this.collects.forget(trade.id);
  }

  private async creditGains(snapshot: BotSnapshot, previous: Seen, ownStepYields: ReadonlySet<string>, now: number): Promise<void> {
    const gains = inventoryGains(previous.inventory, snapshot.inventory);
    if (gains.length === 0) return;
    const trades = this.deps.book.trades();
    // A collect picks up the partner's items from the ground wherever they have walked off to, and its own step yields them.
    const collecting = trades.filter((t) => this.pending.get(t.id) === "collect");
    const partners = new Map(this.partners);
    for (const t of collecting) partners.set(t.partner, snapshot.position);
    const mined = new Set([...ownStepYields].filter((item) => !collecting.some((t) => t.get.some((g) => g.item === item))));
    const credited = attributeGains({ gains, trades, partners, previous: previous.partners, self: snapshot.position, ownStepYields: mined, handoffDistance: this.deps.settings.handoffDistance, recentlyNear: this.near.recently(now) });
    for (const [id, items] of credited) {
      const trade = trades.find((t) => t.id === id);
      if (trade === undefined) continue;
      const { trade: next, used } = creditTrade(trade, items, now);
      if (used.length === 0) continue;
      // A payment kept for this partner before this tick (a tick that had no baseline) must not stay kept for their next trade (review 2026-10-29 S1).
      this.earlier.consume(trade.partner, used, now);
      this.collects.arrivals.explain(used);
      this.collects.paid(id);
      await this.recordStep(next, "received");
    }
    this.collects.arrivals.explain(gains.filter((g) => mined.has(g.item)));
    const kept = this.earlier.keepUnpaidFor({ gains, credited, mined, partners, previous: previous.partners, self: snapshot.position, handoffDistance: this.deps.settings.handoffDistance, recentlyNear: this.near.recently(now) }, now);
    // A kept payment is another player's (or this partner's later trade): no arrival for any trade open now.
    if (kept === null) return;
    this.collects.arrivals.explain(kept.items);
    this.deps.log(`trade: ${sideText(kept.items)} picked up while a player talked to me (kept for ${kept.player}), with no trade agreed yet; kept for a trade agreed within ${EARLIER_GIVE_MS / MINUTE_MS} min`);
  }

  /**
   * A partner who pays my whole proposal has accepted it (a player's acceptance in words never reaches a proposal: only a board
   * offer is accepted by words): every `get` item is covered by what the earlier ledger kept from them and I carry now.
   * The trade is agreed on its own terms by the path of a spoken agreement, which credits the kept gains. A gift proposal
   * (nothing asked back) is never paid, and a partial payment stays kept until a later gain completes the side.
   */
  private async agreePaidProposals(carried: BotSnapshot["inventory"], now: number): Promise<void> {
    for (const trade of this.deps.book.trades().filter((t) => t.state === "proposed" && t.get.length > 0)) {
      const kept = this.earlier.keptFrom(trade.partner, now);
      const covered = trade.get.every((g) => Math.min(kept.find((k) => k.item === g.item)?.count ?? 0, carried.filter((c) => c.name === g.item).reduce((n, c) => n + c.count, 0)) >= g.count);
      if (!covered) continue;
      this.deps.log(`trade: ${trade.partner} paid my proposal ${trade.id}: agreed`);
      const agreed = agreeTrade(trade, { self: this.deps.self, partner: trade.partner, give: trade.give, get: trade.get, first: trade.first, now });
      await this.record(agreed, "agreed");
      await this.startAgreed(agreed, trade.partner, now, carried);
    }
  }

  /** Runs every open trade's clock; a state the clock changed is saved, and a give that came due is handed to the agent. */
  private async settleOpen(now: number): Promise<void> {
    for (const trade of this.deps.book.trades().filter(isOpen)) {
      const settled = settleTrade(trade, now, this.deps.settings, { givePending: this.giveRunning(trade.id, now) });
      if (settled.nobodyGave) this.nobodyGave.add(trade.id);
      else this.nobodyGave.delete(trade.id);
      if (settled.trade.state !== trade.state) await this.record(settled.trade, EVENT_OF_STATE[settled.trade.state]);
      if (isOpen(settled.trade) && this.isGiveDue(settled.trade, now, this.position)) this.takeGive(settled.trade);
      if (isOpen(settled.trade) && this.isAwaitDue(settled.trade, now)) this.takeAwait(settled.trade);
    }
  }

  /** They are to pay first and nothing came: wait near them, once (a dropped wait after a while). */
  private isAwaitDue(t: Trade, now: number): boolean {
    if (t.state !== "agreed" || t.first !== "them" || owedItems(t).length === 0 || this.awaited.has(t.id)) return false;
    const dropped = this.droppedAt.get(awaitKey(t.id));
    return dropped === undefined || now - dropped >= RETAKE_AFTER_MS;
  }

  /** The wait is no pending hand-off: a collect or a give that comes due goes on top of it. */
  private takeAwait(t: Trade): void {
    this.awaited.add(t.id);
    this.awaiting.add(t.id);
    this.deps.takeHandoff({ kind: "await", tradeId: t.id, partner: t.partner });
  }

  /** My side is due: they paid first, or I go first; a failed or dropped give waits for its retry condition. */
  private isGiveDue(t: Trade, now: number, at: Position | null): boolean {
    const mineToGive = t.gaveAt === null && t.give.length > 0 && (t.state === "they_gave" || (t.state === "agreed" && t.first === "me"));
    if (!mineToGive || this.pending.has(t.id)) return false;
    const dropped = this.droppedAt.get(t.id);
    if (dropped !== undefined && now - dropped < RETAKE_AFTER_MS) return false;
    return (this.giveFailures.get(t.id) ?? 0) === 0 || this.partnerNear(t, at);
  }

  /** The partner stands within opening distance of `at` (a failed give is retried only then). */
  private partnerNear(t: Trade, at: Position | null): boolean {
    const there = partnerPosition(this.partners, t.partner);
    return at !== null && there !== null && manhattan(at, there) <= this.deps.persona.settings.conversation.openingDistance;
  }

  /** What of my side an open trade has given and why its give waits, for the line the model reads; undefined for a trade that is not open. */
  giveProgress(tradeId: string): GiveProgress | undefined {
    const trade = this.find(tradeId);
    if (trade === undefined || !isOpen(trade)) return undefined;
    const given = [...(this.givenOutside.get(tradeId) ?? [])].filter(([, count]) => count > 0).map(([item, count]) => ({ item, count }));
    const idle = this.pending.get(tradeId) !== "give"; // a give that runs is handed over: nothing waits
    const retake = idle && this.deps.now() - (this.droppedAt.get(tradeId) ?? -Infinity) < RETAKE_AFTER_MS;
    const away = idle && (this.giveFailures.get(tradeId) ?? 0) > 0 && !this.partnerNear(trade, this.position);
    return { given, waits: away ? "partner_away" : retake ? "retake" : null, nearWithin: this.deps.persona.settings.conversation.openingDistance };
  }

  /** A give for the trade is pending and was taken less than the pay-back time ago: it is bounded by its own walk, toss and wait. */
  private giveRunning(tradeId: string, now: number): boolean {
    return this.pending.get(tradeId) === "give" && now - (this.giveTakenAt.get(tradeId) ?? now) < this.deps.settings.payBackMinutes * MINUTE_MS;
  }

  private takeGive(t: Trade): void {
    this.pending.set(t.id, "give");
    this.giveTakenAt.set(t.id, this.deps.now());
    this.droppedAt.delete(t.id);
    this.deps.takeHandoff({ kind: "give", tradeId: t.id, partner: t.partner, items: t.give });
  }

  private collectView(): CollectView {
    return { pending: this.pending, find: (id) => this.find(id), partners: this.partners, position: this.position };
  }

  /** Credits what reached the bag unseen (walked over after the agreement) to the trades whose collect ended, is about to start, or which the clock ends. */
  private async creditArrived(inventory: BotSnapshot["inventory"], ownStepYields: ReadonlySet<string>, now: number): Promise<void> {
    const due = this.collects.readNow(this.collectView(), now);
    const ends = (t: Trade): boolean => !isOpen(settleTrade(t, now, this.deps.settings, { givePending: this.giveRunning(t.id, now) }).trade);
    for (const { trade, next, used } of this.collects.arrivals.credits(this.deps.book.trades(), { inventory, ownStepYields, now, wanted: (t) => due.has(t.id) || ends(t) })) {
      this.deps.log(`trade: ${sideText(used)} from ${trade.partner} found in the bag, walked over after the agreement`);
      this.earlier.consume(trade.partner, used, now);
      await this.recordStep(next, "received");
    }
  }
}
