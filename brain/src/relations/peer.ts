// What a trade controller answers to the board: the partner's answers to a proposal it posted, and the end of an agreed trade.
import type { BoardPeer } from "./board.ts";
import { agreeTrade, cancelTrade, endedByPartner } from "./trade.ts";
import type { Trade } from "./types.ts";

/** What the board's answers need of the controller that owns them. */
export interface PeerHost {
  readonly self: string;
  readonly now: () => number;
  readonly log: (line: string) => void;
  find(tradeId: string): Trade | undefined;
  /** An exclusive controller step that `settled()` and `busy()` see. */
  tracked(step: () => Promise<void>): Promise<void>;
  record(trade: Trade, event: "agreed" | "cancelled" | "broken"): Promise<void>;
  startAgreed(agreed: Trade, partner: string, now: number): Promise<void>;
  /** Whether my wait for the partner's side of that trade is on the agent's stack. */
  waiting(tradeId: string): boolean;
  /** My wait for that trade walks to the partner, once. */
  comeTo(tradeId: string): void;
}

/** The partner accepted or declined a proposal I posted (my record moves to agreed on the terms it already holds, or is cancelled), ended an agreed trade, is asked what my record holds, or cannot reach me. */
export function boardPeerHandlers(host: PeerHost): BoardPeer {
  return {
    offerAccepted: (tradeId, by) => host.tracked(async () => {
      const trade = host.find(tradeId);
      if (trade === undefined || trade.state !== "proposed") return void host.log(`trade: ${by} accepted ${tradeId}, which is no longer a proposal of mine`);
      const now = host.now();
      const agreed = agreeTrade(trade, { self: host.self, partner: trade.partner, give: trade.give, get: trade.get, first: trade.first, now });
      await host.record(agreed, "agreed");
      await host.startAgreed(agreed, trade.partner, now);
    }),
    offerDeclined: (tradeId, by, why) => host.tracked(async () => {
      const trade = host.find(tradeId);
      if (trade === undefined || trade.state !== "proposed") return;
      await host.record(cancelTrade(trade, host.now(), `${by} ${why}`), "cancelled");
    }),
    // No tell back: only the side that ended the trade tells, so two bots ending at once cannot loop.
    partnerEnded: (tradeId, by, why) => host.tracked(async () => {
      const trade = host.find(tradeId);
      if (trade === undefined) return void host.log(`trade: ${by} ended ${tradeId}, which is no trade of mine`);
      if (trade.partner.toLowerCase() !== by.toLowerCase()) return void host.log(`trade: ${by} says ${tradeId} ${why}, but ${by} is not my partner in it`);
      const ended = endedByPartner(trade, host.now(), by, why);
      if (ended === null) return void host.log(`trade: ${by} says ${tradeId} ${why}; it is ${trade.state}, nothing to end`);
      await host.record(ended, ended.state === "broken" ? "broken" : "cancelled");
    }),
    receivedFor: (tradeId) => host.find(tradeId)?.received ?? null,
    cannotReach: (tradeId, by) => host.tracked(async () => {
      const trade = host.find(tradeId);
      if (trade === undefined) return void host.log(`trade: ${by} cannot reach me for ${tradeId}, which is no trade of mine`);
      if (trade.partner.toLowerCase() !== by.toLowerCase()) return void host.log(`trade: ${by} cannot reach me for ${tradeId}, but ${by} is not my partner in it`);
      if (!host.waiting(tradeId)) return void host.log(`trade: ${by} cannot reach me for ${tradeId}, and I am not waiting for it; nothing to do`);
      host.comeTo(tradeId);
    }),
  };
}
