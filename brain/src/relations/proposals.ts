// The proposals of mine: a propose decision becomes a proposal (replacing my open one, countering a bot's offer), and a proposal is agreed on its own terms when it is paid or asked for.
import type { RelationBook } from "./book.ts";
import type { BoardOffer, TradeBoard } from "./board.ts";
import { type DecisionSeen, givesCarriedOver, termsDifferFromWords, whyProposalDropped } from "./checks.ts";
import type { GiveBook } from "./gives.ts";
import { sideText } from "./items.ts";
import type { TradeLedgers } from "./ledgers.ts";
import { agreeTrade, cancelTrade, proposeTrade, sameDealTerms } from "./trade.ts";
import type { BotSnapshot } from "../runtime-client.ts";
import type { Clocks, Trade, TradeEvent } from "./types.ts";

/** The deal a propose decision builds: the proposer, the partner, both sides, who gives first, and the wall time. */
export type Deal = Parameters<typeof proposeTrade>[0];

/** What the proposals need of the controller: the book and board, the ledgers, the saving of a trade, and the start of an agreed one. */
export interface ProposalHost {
  readonly self: string;
  readonly board: TradeBoard | undefined;
  readonly book: RelationBook;
  readonly gives: GiveBook;
  readonly ledgers: TradeLedgers;
  readonly log: (line: string) => void;
  readonly find: (tradeId: string) => Trade | undefined;
  readonly record: (trade: Trade, ...events: TradeEvent["event"][]) => Promise<void>;
  readonly startAgreed: (agreed: Trade, partner: string, at: Clocks, carried: BotSnapshot["inventory"]) => Promise<void>;
}

export class OwnProposals {
  constructor(private readonly host: ProposalHost) {}

  /** A propose: replaces my open proposal to them (a restated one stays), and counters their offer when I read it first (`seen`, bot partners). */
  async propose(deal: Deal, at: Clocks, mine: Trade | undefined, theirOffer: BoardOffer | undefined, seen: DecisionSeen | undefined, carried: BotSnapshot["inventory"]): Promise<string | null> {
    const { partner: speaker, now } = deal;
    const { board, self, log, gives, ledgers } = this.host;
    const dropped = whyProposalDropped({ speaker, mine, ownOfferId: board?.offerFrom(self, speaker)?.id, local: board?.isLocal(speaker) === true, theirOffer, heardAt: seen?.heardAt, seenOfferId: seen?.seenOfferId });
    if (dropped !== null) return this.noted(null, dropped);
    if (mine !== undefined && sameDealTerms(mine, deal) && mine.first === deal.first) return this.noted(mine.id, `trade: my proposal to ${speaker} repeats ${mine.id}, which stays open`);
    const kept = mine === undefined ? [] : givesCarriedOver(gives.givenOf(mine.id), ledgers.carriedOver(mine.id));
    if (mine !== undefined) await this.host.record(cancelTrade(mine, now, "replaced"), "cancelled");
    if (theirOffer !== undefined) {
      board?.decline(theirOffer.id, self, "countered");
      log(`trade: counter-offer to ${speaker}: I give ${sideText(deal.give)}, I get ${sideText(deal.get)}; their ${theirOffer.id} declined`);
    }
    const id = await this.proposeAndPost(deal, at, carried, seen?.say);
    const fresh = this.host.find(id);
    if (fresh !== undefined) for (const [item, count] of kept) gives.credit(fresh, item, count);
    return id;
  }

  /** A new proposal of mine, posted on the board when the partner is a bot of this brain. */
  async proposeAndPost(deal: Deal, at: Clocks, carried: BotSnapshot["inventory"], said?: string): Promise<string> {
    for (const line of termsDifferFromWords(said, [...deal.give, ...deal.get])) this.host.log(line);
    const proposed = proposeTrade(deal);
    await this.host.record(proposed, "proposed");
    this.post(proposed);
    await this.host.ledgers.claimEarlier(proposed, at, carried);
    // A payment dropped while the model was still deciding is already kept: the proposal it answers is agreed as it is posted.
    await this.agreePaid(carried, at);
    return proposed.id;
  }

  /** A bot of this brain I propose or counter to: the proposal goes on the board for the partner's accept. */
  private post(trade: Trade): void {
    const { board, self } = this.host;
    if (board?.isLocal(trade.partner) !== true) return;
    board.post({ id: trade.id, proposer: self, partner: trade.partner, give: trade.give, get: trade.get, first: trade.first, postedAt: trade.createdAt });
  }

  /**
   * A partner who pays my whole proposal has accepted it (a player's acceptance in words never reaches a proposal: only a board
   * offer is accepted by words): every `get` item is covered by what the earlier ledger kept from them and I carry now.
   * The trade is agreed on its own terms by the path of a spoken agreement, which credits the kept gains. A gift proposal
   * (nothing asked back) is never paid, and a partial payment stays kept until a later gain completes the side.
   */
  async agreePaid(carried: BotSnapshot["inventory"], at: Clocks): Promise<void> {
    for (const trade of this.host.book.trades().filter((t) => t.state === "proposed" && t.get.length > 0)) {
      const kept = this.host.ledgers.earlier.keptFrom(trade.partner, at.now);
      const covered = trade.get.every((g) => Math.min(kept.find((k) => k.item === g.item)?.count ?? 0, carried.filter((c) => c.name === g.item).reduce((n, c) => n + c.count, 0)) >= g.count);
      if (!covered) continue;
      await this.agree(trade, at, carried, `trade: ${trade.partner} paid my proposal ${trade.id}: agreed`);
    }
  }

  /** The proposal `propose` answered (a payment may have agreed it already) is agreed as it stands; the trade's id, or null when none was proposed. */
  async agreeAsked(id: string | null, speaker: string, at: Clocks, carried: BotSnapshot["inventory"]): Promise<string | null> {
    const trade = id === null ? undefined : this.host.find(id);
    if (trade?.state !== "proposed") return id;
    return (await this.agree(trade, at, carried, `trade: ${speaker} asked for the gift: agreed`)).id;
  }

  /** A proposal of mine agreed on its own terms (it keeps its id): saved, then the give starts at once if covered or is handed to the agent. */
  private async agree(trade: Trade, at: Clocks, carried: BotSnapshot["inventory"], line: string): Promise<Trade> {
    this.host.log(line);
    const agreed = agreeTrade(trade, { self: this.host.self, partner: trade.partner, give: trade.give, get: trade.get, first: trade.first, now: at.wallNow });
    await this.host.record(agreed, "agreed");
    await this.host.startAgreed(agreed, trade.partner, at, carried);
    return agreed;
  }

  private noted<T>(answer: T, line: string): T { this.host.log(line); return answer; }
}
