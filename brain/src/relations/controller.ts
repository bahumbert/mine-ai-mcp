// The per-agent trade controller: chat decisions become trades, payments are credited, deadlines run, hand-offs and judgments are asked for.
import type { GistPartner, Mind, TradeDecision } from "../mind.ts";
import type { Persona } from "../persona.ts";
import type { BotSnapshot, Position } from "../runtime-client.ts";
import { manhattan } from "../conversation/state.ts";
import type { BoardOffer, BoardPeer, TradeBoard } from "./board.ts";
import type { RelationBook } from "./book.ts";
import { checkTradeDecision } from "./checks.ts";
import { EARLIER_GIVE_MS, EarlierLedger } from "./earlier.ts";
import { awaitKey, COLLECT_RADIUS, type Handoff, type HandoffEnd } from "./handoff.ts";
import { sideText } from "./items.ts";
import { relationsBlock } from "./prompts.ts";
import { forgetOldSaid, withEndedTrade, withFeeling, withSaid, withTrade } from "./record.ts";
import { AGREED_STATES, agreeTrade, attributeGains, cancelTrade, creditTrade, failTrade, inventoryGains, isOpen, markGave, owedItems, proposeTrade, settleTrade } from "./trade.ts";
import type { ItemCount, RelationEvent, Trade, TradeEvent, TradeSettings } from "./types.ts";

/** A partner's line after agreement starts this watch for their payment before the collect fallback. */
const COLLECT_WATCH_MS = 5_000;
/** The judge call waits this long (wall clock) for a model slot, then leaves the feeling unchanged. */
const JUDGE_WAIT_MS = 120_000;
/** A hand-off dropped by a shelter or a stop is taken again after this long. */
const RETAKE_AFTER_MS = 30_000;
/** A payment picked up within this long after the partner was last near is still theirs. */
const RECENT_NEAR_MS = 30_000;
/** A give is tried this many times (the second only with the partner in talk range) before it counts as failed. */
const GIVE_ATTEMPTS = 2;
/** A propose or accept that repeats a trade that ended `done` this recently is a late chat reply, not a new deal. */
const REPEAT_AFTER_DONE_MS = 2 * 60_000;

export interface TradeControllerDeps {
  readonly self: string;
  readonly persona: Persona;
  readonly book: RelationBook;
  readonly mind: Mind;
  readonly settings: TradeSettings;
  readonly now: () => number;
  /** The agent pushes the routine objective for this hand-off. */
  readonly takeHandoff: (h: Handoff) => void;
  readonly modelSlotFree: () => boolean;
  readonly inConversationWith: (name: string) => boolean;
  readonly journal: (e: TradeEvent | RelationEvent) => void;
  readonly log: (line: string) => void;
  /** The brain's trade board: a trade with another bot of this brain is made on the proposer's terms. Absent: every partner is treated as outside the brain. */
  readonly board?: TradeBoard;
}

type EventName = TradeEvent["event"];

interface PendingJudgment {
  readonly partner: string;
  readonly trade: Trade;
  readonly since: number;
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const EVENT_OF_STATE: Partial<Record<Trade["state"], EventName>> = { proposed: "proposed", agreed: "agreed", i_gave: "gave", they_gave: "received", done: "done", broken: "broken", cancelled: "cancelled" };

const flipped = (first: "me" | "them"): "me" | "them" => (first === "me" ? "them" : "me");
const sameTerms = (a: TradeDecision, b: TradeDecision): boolean => JSON.stringify([a.give, a.get, a.first]) === JSON.stringify([b.give, b.get, b.first]);

const dealKey = (items: readonly ItemCount[]): string => JSON.stringify([...items].map((i) => [i.item, i.count]).sort());
/** The same items and counts on both sides, in any order; who gives first does not matter. */
export const sameDealTerms = (a: Pick<TradeDecision, "give" | "get">, b: Pick<TradeDecision, "give" | "get">): boolean => dealKey(a.give) === dealKey(b.give) && dealKey(a.get) === dealKey(b.get);

export class TradeController implements BoardPeer {
  private previous: { inventory: BotSnapshot["inventory"]; partners: ReadonlyMap<string, Position | null> } | null = null;
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
  /** Partner (lower case) -> the wall-clock time they were last within hand-off distance of me. */
  private readonly nearAt = new Map<string, number>();
  /** Trade id -> when the partner's line started the wait for their payment. */
  private readonly watches = new Map<string, number>();
  /** Trade id -> item -> count of my side given by a `give_item` outside the hand-off (memory only: a restart loses it). */
  private readonly givenOutside = new Map<string, Map<string, number>>();
  /** Gives a partner took, and payments picked up while they talked, with no trade yet: kept for the next trade with them. */
  private readonly earlier = new EarlierLedger();
  private readonly collected = new Set<string>();
  private readonly nobodyGave = new Set<string>();
  private readonly judging: PendingJudgment[] = [];
  private readonly running = new Set<Promise<void>>();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: TradeControllerDeps) {
    deps.board?.join(deps.self, this);
  }

  /** Null when a propose or accept can become a trade, else the reason that is sent back to the chat tier once. */
  checkDecision(d: TradeDecision, speaker: string, snapshot: BotSnapshot): string | null {
    return checkTradeDecision({ decision: this.termsOf(d, speaker), speaker, snapshot, trades: this.deps.book.trades(), maxOpenTrades: this.deps.settings.maxOpenTrades, reach: this.deps.settings.tradeReach, givenOutside: this.creditedTo(speaker) });
  }

  /** The proposal the partner (a bot of this brain) posted to me, still open. */
  private offerFromPartner(partner: string): BoardOffer | undefined {
    return this.deps.board?.offerFrom(partner, this.deps.self);
  }

  /** What an accept stands for: the proposer's terms, mirrored, when a bot of this brain proposed to me; else what my model wrote. */
  private termsOf(d: TradeDecision, partner: string): TradeDecision {
    const offer = d.action === "accept" ? this.offerFromPartner(partner) : undefined;
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
      const current = await this.claimEarlier(agreed, now);
      if (await this.giveIfCovered(current, trade.partner)) return;
      if (this.isGiveDue(current, now, null)) this.takeGive(current);
    });
  }

  /** The partner declined the proposal I posted: my record is cancelled. */
  offerDeclined(tradeId: string, by: string, why: string): Promise<void> {
    return this.tracked(async () => {
      const trade = this.find(tradeId);
      if (trade === undefined || trade.state !== "proposed") return;
      await this.record(cancelTrade(trade, this.deps.now(), `${by} ${why}`), "cancelled");
    });
  }

  /** The chat decision's trade: a proposal, an agreement (the give starts when I go first) or an end. Answers the id of the trade it proposed or agreed, else null. */
  onDecision(d: TradeDecision, speaker: string, snapshot: BotSnapshot): Promise<string | null> {
    return this.exclusive(async () => {
      const now = this.deps.now();
      // The inventory the next tick's gains are counted from, when no tick has been watching.
      this.previous ??= { inventory: snapshot.inventory, partners: new Map(snapshot.players.map((p) => [p.username, p.position])) };
      const mine = this.openWith(speaker);
      const local = this.deps.board?.isLocal(speaker) === true;
      const offer = d.action === "accept" ? this.offerFromPartner(speaker) : undefined;
      const terms = this.termsOf(d, speaker);
      const deal = { self: this.deps.self, partner: speaker, give: terms.give, get: terms.get, first: terms.first, now };
      const repeated = d.action !== "decline" && d.action !== "cancel" && mine === undefined && this.offerFromPartner(speaker) === undefined ? this.repeatOfDone(speaker, terms, now) : undefined;
      if (repeated !== undefined) {
        this.deps.log(`trade: a ${d.action} of ${speaker} ignored, it repeats ${repeated.id}, done ${Math.round((now - (repeated.endedAt ?? now)) / 1000)} s ago`);
        return null;
      }
      if (d.action === "propose") {
        if (mine !== undefined) {
          this.deps.log(`trade: a proposal to ${speaker} ignored, ${mine.id} is still open`);
          return null;
        }
        if (local && this.offerFromPartner(speaker) !== undefined) {
          this.deps.log(`trade: my proposal to ${speaker} dropped, their older proposal to me stands`);
          return null;
        }
        return this.proposeAndPost(deal, now);
      }
      if (d.action === "accept" && local && offer === undefined) {
        if (mine !== undefined) {
          this.deps.log(`trade: an accept of ${speaker} ignored, ${mine.id} is still open and they proposed nothing to me`);
          return null;
        }
        // They offered in words only (or the offer is gone): my terms stand as a counter-offer, and their accept closes it on both sides.
        this.deps.log(`trade: no proposal from ${speaker} on the board; my terms are posted as a counter-offer`);
        return this.proposeAndPost(deal, now);
      }
      if (d.action === "accept") {
        if (offer !== undefined && !sameTerms(d, terms)) this.deps.log(`trade: terms taken from ${speaker}'s offer: I give ${sideText(terms.give)}, I get ${sideText(terms.get)} (my reply said ${sideText(d.give)} for ${sideText(d.get)})`);
        const agreed = offer === undefined ? agreeTrade(mine?.state === "proposed" ? mine : null, deal) : { ...agreeTrade(null, deal), id: offer.id };
        // Before the record: saving an agreed trade takes its id off the board.
        if (offer !== undefined) this.deps.board?.accept(offer.id, this.deps.self);
        await this.record(agreed, "agreed");
        const current = await this.claimEarlier(agreed, now, snapshot.inventory);
        if (await this.giveIfCovered(current, speaker)) return agreed.id;
        if (this.isGiveDue(current, now, null)) this.takeGive(current);
        return agreed.id;
      }
      const theirs = this.offerFromPartner(speaker);
      if (theirs !== undefined) this.deps.board?.decline(theirs.id, this.deps.self, d.action === "decline" ? "declined" : "cancelled");
      if (mine !== undefined) await this.record(cancelTrade(mine, now, d.action === "decline" ? "I declined" : "I cancelled"), "cancelled");
      return null;
    });
  }

  /** The trade with the speaker that ended `done` within the repeat window on the same terms, if any: a chat reply written while it was open lands after it. */
  private repeatOfDone(speaker: string, terms: TradeDecision, now: number): Trade | undefined {
    return this.deps.book.trades().find((t) => t.state === "done" && same(t.partner, speaker) && t.endedAt !== null && now - t.endedAt <= REPEAT_AFTER_DONE_MS && sameDealTerms(t, terms));
  }

  /** A new proposal of mine, posted on the board when the partner is a bot of this brain. */
  private async proposeAndPost(deal: Parameters<typeof proposeTrade>[0], now: number): Promise<string> {
    const proposed = proposeTrade(deal);
    await this.record(proposed, "proposed");
    this.post(proposed);
    await this.claimEarlier(proposed, now);
    return proposed.id;
  }

  /** A `give_item` the partner took, outside the trade's hand-off, counts toward my side of the oldest open trade with them whose side has the item (a proposed one too; capped at what is lacking); the side covered and agreed, the trade is given. */
  gaveOutside(partner: string, item: string, count: number): Promise<void> {
    return this.exclusive(async () => {
      const trade = this.deps.book.trades().filter((t) => isOpen(t) && same(t.partner, partner) && (t.state === "proposed" || t.state === "agreed" || t.state === "they_gave") && t.gaveAt === null && t.give.some((g) => g.item === item))
        .sort((a, b) => a.createdAt - b.createdAt)[0];
      if (trade === undefined) {
        this.earlier.gave(partner, item, count, this.deps.now());
        return void this.deps.log(`trade: ${count} ${item} given to ${partner} outside a hand-off matches no open trade of mine; not counted yet, kept for a trade proposed within ${EARLIER_GIVE_MS / 60_000} min`);
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
    await this.record({ ...gave, note: gave.note === "" ? `gave ${sideText(trade.give)} to ${partner}, outside the hand-off` : gave.note }, "gave", ...(gave.state === "done" ? (["done"] as const) : []));
    return true;
  }

  /** What of my side the partner already took, per item: the credit of their open trade and the earlier gives still inside the window. */
  private creditedTo(partner: string): ReadonlyMap<string, number> {
    const credited = new Map<string, number>();
    const trade = this.openWith(partner);
    for (const [item, count] of trade === undefined ? [] : this.givenOutside.get(trade.id) ?? []) credited.set(item, count);
    if (trade === undefined || trade.state === "proposed") for (const e of this.earlier.givesTo(partner, this.deps.now())) credited.set(e.item, (credited.get(e.item) ?? 0) + e.count);
    return credited;
  }

  /** A trade just made takes the partner's earlier gives still inside the window, once (capped at its side); an agreed one also the payment picked up before the agreement. Returns the trade as it stands then. */
  private async claimEarlier(trade: Trade, now: number, carried = this.previous?.inventory ?? []): Promise<Trade> {
    for (const e of this.earlier.claimGives(trade, now)) this.creditGiven(trade, e.item, e.count);
    const { trade: next, used } = creditTrade(trade, trade.state === "agreed" ? this.earlier.claimGains(trade, carried, now) : [], now);
    if (used.length > 0) await this.record(next, "received", ...(next.state === "done" ? (["done"] as const) : []));
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
  handoffSkipped(tradeId: string): void {
    this.pending.delete(tradeId);
  }

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
    for (const t of this.deps.book.trades()) {
      const waiting = (t.state === "agreed" || t.state === "i_gave") && owedItems(t).length > 0 && (t.agreedAt ?? Infinity) <= at;
      if (waiting && same(t.partner, speaker) && !this.collected.has(t.id) && !this.watches.has(t.id)) this.watches.set(t.id, at);
    }
  }

  /** The agent's poll tick: credits gains, runs the deadlines, takes due hand-offs and judgments. Never waits on a model. */
  tick(snapshot: BotSnapshot, ownStepYields: ReadonlySet<string>, signal: AbortSignal): Promise<void> {
    return this.exclusive(async () => {
      const now = this.deps.now();
      const previous = this.previous;
      this.partners = new Map(snapshot.players.map((p) => [p.username, p.position]));
      this.previous = { inventory: snapshot.inventory, partners: this.partners };
      this.position = snapshot.position;
      this.noteNear(snapshot, now);
      if (previous !== null) await this.creditGains(snapshot, previous, ownStepYields, now);
      await this.settleOpen(now);
      this.startCollects(now);
      this.runJudgments(now, signal);
      if (!this.busy()) this.previous = null;
    });
  }

  /** Whether the agent should tick: a trade is open, one broken by them may still be paid late, a hand-off or a judgment is waiting. */
  busy(withWindow = true): boolean {
    const now = this.deps.now();
    const waiting = this.deps.book.trades().some((t) => isOpen(t) || (t.state === "broken" && t.brokenBy === "them" && now - (t.endedAt ?? now) < this.deps.settings.offersForgetMinutes * 60_000 && owedItems(t).length > 0));
    return waiting || (withWindow && this.earlier.watching(now)) || this.pending.size > 0 || this.judging.length > 0 || this.running.size > 0;
  }

  /** Busy for a player's window alone (no trade, hand-off or judgment): the agent may poll slowly. */
  onlyWatching(): boolean { return this.busy() && !this.busy(false); }

  /** A hand-off ended: a give is counted given, or failed (items gone at once; otherwise tried once more with the partner near, a not-taken one also after a wait). */
  handoffEnded(tradeId: string, outcome: "done" | "items_gone" | "not_taken" | "failed", detail: string): Promise<void> {
    return this.exclusive(async () => {
      const kind = this.pending.get(tradeId) ?? "give";
      this.pending.delete(tradeId);
      const trade = this.find(tradeId);
      if (trade === undefined || !isOpen(trade)) return;
      const now = this.deps.now();
      if (kind === "collect") {
        this.deps.log(`trade: collect for ${tradeId} ${outcome}: ${detail}`);
      } else if (outcome === "done") {
        const gave = markGave(trade, now);
        await this.record({ ...gave, note: gave.note === "" ? detail : gave.note }, "gave", ...(gave.state === "done" ? (["done"] as const) : []));
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

  /** The gist's judgment of each other member and what they said they have or need. */
  onConversationEnded(partners: readonly GistPartner[]): Promise<void> {
    return this.exclusive(async () => {
      const now = this.deps.now();
      for (const p of partners) {
        if (p.judged === null && p.has.length === 0 && p.needs.length === 0) continue;
        const from = this.deps.book.get(p.name)?.feeling ?? 0;
        const next = await this.deps.book.update(p.name, (r) => {
          const said = forgetOldSaid(withSaid(r, p.has, p.needs, now), now, this.deps.settings.offersForgetMinutes);
          return p.judged === null ? said : withFeeling(said, p.judged);
        });
        if (p.judged === null) continue;
        this.deps.journal({ kind: "relation", event: "judged", partner: next.partner, from, to: next.feeling, word: next.word, why: next.why, by: "gist" });
        for (let i = this.judging.length - 1; i >= 0; i -= 1) if (same(this.judging[i]!.partner, p.name)) this.judging.splice(i, 1);
      }
    });
  }

  /** The relations block of a chat request: the records of those in it, trades nobody started, and what the objective lacks. */
  block(partners: readonly string[], lacks: readonly string[]): string {
    const idle = [...this.nobodyGave].map((id) => this.find(id)).filter((t): t is Trade => t !== undefined)
      .map((t) => `Nobody has given yet on your agreed trade with ${t.partner} (you give ${sideText(t.give) || "nothing"}, they give ${sideText(t.get) || "nothing"}): you may go first, ask them to, or cancel it.`);
    return relationsBlock([...this.deps.book.summaries(partners), ...idle], lacks);
  }

  /** Resolves when the judgments started so far are over (the agent's shutdown, the tests). */
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

  private find(tradeId: string): Trade | undefined {
    return this.deps.book.trades().find((t) => t.id === tradeId);
  }

  /** The newest trade with that partner proposed at or after `since`; a read, nothing is written. */
  latestWith(partner: string, since: number): Trade | null {
    let newest: Trade | null = null;
    for (const t of this.deps.book.trades()) {
      if (same(t.partner, partner) && t.createdAt >= since && (newest === null || t.createdAt >= newest.createdAt)) newest = t;
    }
    return newest;
  }

  /** The newest trade with any partner created at or after `since` that is agreed or further; a read, nothing is written. */
  agreedSince(since: number): Trade | null {
    let newest: Trade | null = null;
    for (const t of this.deps.book.trades()) {
      if (t.createdAt >= since && AGREED_STATES.has(t.state) && (newest === null || t.createdAt >= newest.createdAt)) newest = t;
    }
    return newest;
  }

  private openWith(partner: string): Trade | undefined {
    return this.deps.book.trades().find((t) => isOpen(t) && same(t.partner, partner));
  }

  /** Saves the trade in its partner's record (counting an end into the facts) and journals the events. */
  private async record(trade: Trade, ...events: EventName[]): Promise<void> {
    const ended = !isOpen(trade);
    if (trade.state !== "proposed") this.deps.board?.withdraw(trade.id);
    await this.deps.book.update(trade.partner, (r) => (ended ? withEndedTrade(r, trade) : withTrade(r, trade)));
    for (const event of events) this.deps.journal({ kind: "trade", event, partner: trade.partner, tradeId: trade.id, give: trade.give, get: trade.get, first: trade.first, note: trade.note });
    if (!ended) return;
    this.nobodyGave.delete(trade.id);
    this.watches.delete(trade.id);
    this.givenOutside.delete(trade.id);
    this.giveTakenAt.delete(trade.id);
    // A cancelled trade moved nothing: there is nothing to judge.
    if (trade.state !== "cancelled") this.judging.push({ partner: trade.partner, trade, since: this.deps.now() });
  }

  private async creditGains(snapshot: BotSnapshot, previous: { inventory: BotSnapshot["inventory"]; partners: ReadonlyMap<string, Position | null> }, ownStepYields: ReadonlySet<string>, now: number): Promise<void> {
    const gains = inventoryGains(previous.inventory, snapshot.inventory);
    if (gains.length === 0) return;
    const trades = this.deps.book.trades();
    // A collect picks up the partner's items from the ground wherever they have walked off to, and its own step yields them.
    const collecting = trades.filter((t) => this.pending.get(t.id) === "collect");
    const partners = new Map(this.partners);
    for (const t of collecting) partners.set(t.partner, snapshot.position);
    const mined = new Set([...ownStepYields].filter((item) => !collecting.some((t) => t.get.some((g) => g.item === item))));
    const credited = attributeGains({ gains, trades, partners, previous: previous.partners, self: snapshot.position, ownStepYields: mined, handoffDistance: this.deps.settings.handoffDistance, recentlyNear: this.recentlyNear(now) });
    for (const [id, items] of credited) {
      const trade = trades.find((t) => t.id === id);
      if (trade === undefined) continue;
      const { trade: next, used } = creditTrade(trade, items, now);
      if (used.length === 0) continue;
      this.watches.delete(id);
      await this.record({ ...next, note: next.note }, "received", ...(next.state === "done" ? (["done"] as const) : []));
    }
    const kept = this.earlier.keepUnpaid({ gains, credited, mined, partners, previous: previous.partners, self: snapshot.position, handoffDistance: this.deps.settings.handoffDistance, recentlyNear: this.recentlyNear(now) }, now);
    if (kept.length > 0) this.deps.log(`trade: ${sideText(kept)} picked up while a player talked to me, with no trade agreed yet; kept for a trade agreed within ${EARLIER_GIVE_MS / 60_000} min`);
  }

  /** Remembers who stands within hand-off distance now; the ones not near for a while are forgotten. */
  private noteNear(snapshot: BotSnapshot, now: number): void {
    for (const p of snapshot.players) {
      if (p.position !== null && manhattan(snapshot.position, p.position) <= this.deps.settings.handoffDistance) this.nearAt.set(p.username.toLowerCase(), now);
    }
    for (const [name, at] of this.nearAt) if (now - at > RECENT_NEAR_MS) this.nearAt.delete(name);
  }

  private recentlyNear(now: number): ReadonlySet<string> {
    return new Set([...this.nearAt].filter(([, at]) => now - at <= RECENT_NEAR_MS).map(([name]) => name));
  }

  /** Runs every open trade's clock; a state the clock changed is saved, and a give that came due is handed to the agent. */
  private async settleOpen(now: number): Promise<void> {
    for (const trade of this.deps.book.trades().filter(isOpen)) {
      const settled = settleTrade(trade, now, this.deps.settings, { givePending: this.giveRunning(trade.id, now) });
      if (settled.nobodyGave) this.nobodyGave.add(trade.id);
      else this.nobodyGave.delete(trade.id);
      if (settled.trade.state !== trade.state) await this.record(settled.trade, EVENT_OF_STATE[settled.trade.state] ?? "gave");
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
    if ((this.giveFailures.get(t.id) ?? 0) === 0) return true;
    const there = this.partners.get(t.partner) ?? null;
    return at !== null && there !== null && manhattan(at, there) <= this.deps.persona.settings.conversation.openingDistance;
  }

  /** A give for the trade is pending and was taken less than the pay-back time ago: it is bounded by its own walk, toss and wait. */
  private giveRunning(tradeId: string, now: number): boolean {
    return this.pending.get(tradeId) === "give" && now - (this.giveTakenAt.get(tradeId) ?? now) < this.deps.settings.payBackMinutes * 60_000;
  }

  private takeGive(t: Trade): void {
    this.pending.set(t.id, "give");
    this.giveTakenAt.set(t.id, this.deps.now());
    this.droppedAt.delete(t.id);
    this.deps.takeHandoff({ kind: "give", tradeId: t.id, partner: t.partner, items: t.give });
  }

  /** The partner spoke after agreeing and nothing came in 5 s while they stand near: pick up what they may have dropped, once. */
  private startCollects(now: number): void {
    for (const [id, since] of this.watches) {
      const trade = this.find(id);
      if (trade === undefined || !isOpen(trade) || owedItems(trade).length === 0) {
        this.watches.delete(id);
        continue;
      }
      const there = this.partners.get(trade.partner) ?? null;
      const near = there !== null && this.position !== null && manhattan(this.position, there) <= COLLECT_RADIUS;
      if (now - since < COLLECT_WATCH_MS || !near || this.pending.has(id)) continue;
      this.watches.delete(id);
      this.collected.add(id);
      this.pending.set(id, "collect");
      this.deps.takeHandoff({ kind: "collect", tradeId: id, items: owedItems(trade) });
    }
  }

  /** Judgments of ended trades: none inside a conversation (its gist judges), a model slot waited for up to 2 minutes. */
  private runJudgments(now: number, signal: AbortSignal): void {
    for (const j of [...this.judging]) {
      const drop = (): void => void this.judging.splice(this.judging.indexOf(j), 1);
      if (this.deps.inConversationWith(j.partner)) drop();
      else if (this.deps.modelSlotFree()) {
        drop();
        this.judge(j, signal);
      } else if (now - j.since >= JUDGE_WAIT_MS) {
        drop();
        this.deps.log(`relation: no model slot to judge ${j.partner} after trade ${j.trade.id} within ${JUDGE_WAIT_MS / 1_000} s; the feeling stays`);
      }
    }
  }

  private judge(j: PendingJudgment, signal: AbortSignal): void {
    const { book, mind, persona, log, journal } = this.deps;
    const task = (async () => {
      try {
        const from = book.get(j.partner)?.feeling ?? 0;
        const judged = await mind.judgeRelation({ persona, partner: j.partner, block: book.summaries([j.partner])[0] ?? "", trade: j.trade }, signal);
        if (judged === null) return void log(`relation: no usable judgment of ${j.partner}`);
        const next = await book.update(j.partner, (r) => withFeeling(r, judged));
        journal({ kind: "relation", event: "judged", partner: next.partner, from, to: next.feeling, word: next.word, why: next.why, by: "judge" });
      } catch (error) {
        log(`relation: could not judge ${j.partner}: ${String(error)}`);
      }
    })();
    this.running.add(task);
    void task.finally(() => this.running.delete(task));
  }
}
