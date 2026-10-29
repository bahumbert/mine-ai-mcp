// The trade board: the proposals open between the characters of one brain process, so that both sides of a trade hold
// the same terms under the same id (spec 2026-10-22 trading F8). In memory only: a restart empties it, the records in
// the books stay.
import type { ItemCount } from "./types.ts";

/** A proposal between two local characters, in the proposer's words: its give is what the proposer hands over. */
export interface BoardOffer {
  readonly id: string;
  readonly proposer: string;
  readonly partner: string;
  readonly give: readonly ItemCount[];
  readonly get: readonly ItemCount[];
  readonly first: "me" | "them";
  readonly postedAt: number;
}

/** What a character's trade controller answers to the board: the partner's answer to a proposal it posted. */
export interface BoardPeer {
  offerAccepted(id: string, by: string): Promise<void>;
  offerDeclined(id: string, by: string, why: string): Promise<void>;
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

export class TradeBoard {
  private readonly peers = new Map<string, BoardPeer>();
  private readonly offers = new Map<string, BoardOffer>();

  constructor(private readonly log: (line: string) => void = () => undefined) {}

  /** A character of this brain takes its place on the board. */
  join(name: string, peer: BoardPeer): void {
    this.peers.set(name.toLowerCase(), peer);
  }

  /** Whether `name` is a character of this brain: only trades with them go through the board. */
  isLocal(name: string): boolean {
    return this.peers.has(name.toLowerCase());
  }

  /** The proposal `proposer` made to `partner` that is still open. */
  offerFrom(proposer: string, partner: string): BoardOffer | undefined {
    return [...this.offers.values()].find((offer) => same(offer.proposer, proposer) && same(offer.partner, partner));
  }

  post(offer: BoardOffer): void {
    this.offers.set(offer.id, offer);
  }

  /** The proposal is over (answered, cancelled or out of time): nothing is left to answer. */
  withdraw(id: string): void {
    this.offers.delete(id);
  }

  /** `by` accepts the proposal: it leaves the board and its proposer moves its record to agreed. The proposer is told in the background. */
  accept(id: string, by: string): void {
    this.answer(id, (peer, offer) => peer.offerAccepted(offer.id, by), `${by} accepted`);
  }

  /** `by` declines or cancels the proposal: it leaves the board and its proposer cancels its record. */
  decline(id: string, by: string, why: string): void {
    this.answer(id, (peer, offer) => peer.offerDeclined(offer.id, by, why), `${by} ${why}`);
  }

  private answer(id: string, tell: (peer: BoardPeer, offer: BoardOffer) => Promise<void>, what: string): void {
    const offer = this.offers.get(id);
    if (offer === undefined) return;
    this.offers.delete(id);
    const peer = this.peers.get(offer.proposer.toLowerCase());
    if (peer === undefined) return;
    // Not awaited: the answering controller holds its own turn, and waiting for the proposer's could deadlock a crossing answer.
    tell(peer, offer).catch((error: unknown) => this.log(`trade board: could not tell ${offer.proposer} that ${what}: ${String(error)}`));
  }
}
