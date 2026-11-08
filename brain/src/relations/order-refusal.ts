// Whether an order from a speaker is taken while a trade is open with them (or their line's trade came to nothing), and why not.
import type { Activity } from "../activities.ts";
import type { Step } from "../actions.ts";
import type { ChatDecision, Objective } from "../mind.ts";
import type { AgentRelations } from "./agent-relations.ts";

/** The code a `give_item` step's failure starts with when a give to the requester is outside any trade that counts it (spec 2026-11-08-trading-p2-fixes D2). */
export const GIVE_OUTSIDE_TRADE = "[GIVE_OUTSIDE_TRADE]";

/**
 * Why a `give_item` step of an order to its own requester must not run, else null: no trade of mine counts it (spec
 * 2026-11-08-trading-p2-fixes D2). Never the trade's own hand-off, an own goal or another player's order. The requester
 * is named as the order's speaker spelled it, whatever case the step used.
 */
export function stepGiveRefusal(relations: AgentRelations | null, objective: Objective, step: Step): string | null {
  const { requester } = objective;
  if (step.skill !== "give_item" || objective.handoff !== undefined || requester === null || requester.toLowerCase() !== step.player.toLowerCase()) return null;
  return relations?.giveOutsideTrade(requester, step.item, step.count, objective.tradeCameToNothing === true) ?? null;
}

/** An order is refused with the log line saying why, or taken, with a log line and the marks the agent keeps when the trade made it special. */
export type OrderVerdict =
  | { readonly kind: "refused"; readonly log: string }
  | { readonly kind: "taken"; readonly log?: string; readonly tradeCameToNothing?: true; readonly duringTrade?: string };

/**
 * Whether an order (an `act`, a `later`, the request of a stop) from `speaker` is taken (spec 2026-11-08-trading-p2-fixes D1).
 * The line's own trade, when it made one, was handled before (`tradeId`: its id, null when none came of it). While a trade or
 * offer is open with the speaker, or the line carried a trade that came to nothing, only an order the model read as an
 * activity other than trading (`purpose`, from the chat tier's `work`) is taken: every give and every narration of the partner's
 * act is read as no work, and a give outside the trade is a second hand-off it never sees (s3h). A give inside a taken order
 * is guarded at its step instead (`AgentRelations.giveOutsideTrade`). Then the roll made for the speaker's mood decides
 * (owner 2026-10-31; the model was told before it answered). No relations: taken.
 */
export function orderVerdict(relations: AgentRelations | null, decision: ChatDecision, speaker: string, purpose: Activity | null, tradeId: string | null): OrderVerdict {
  if (relations === null) return { kind: "taken" };
  const request = JSON.stringify(decision.request);
  const action = decision.trade?.action;
  // Propose and accept lines whose trade the checks refused (a decline or cancel line made no promise to break: no mark).
  const came = decision.tradeDropped === true || (tradeId === null && (action === "propose" || action === "accept"));
  const tradeLine = decision.trade !== undefined || decision.tradeDropped === true;
  const open = relations.tradeOpenWith(speaker);
  const activity = purpose !== null && purpose !== "trading";
  if (!activity) {
    if (tradeLine) return { kind: "refused", log: `not taken: the line's trade with ${speaker} came to nothing (${request})` };
    if (open !== null) return { kind: "refused", log: `not taken: ${speaker} and I have trade ${open} open; its hand-off is how items move (${request})` };
  }
  const mood = relations.obeys(speaker);
  if (mood !== null && !mood.obeys) {
    return { kind: "refused", log: `not taken: ${speaker} rated ${Math.round(relations.rating(speaker))}, chance ${Math.round(mood.chance * 100)} %, rolled no (${request})` };
  }
  if (came) {
    return { kind: "taken", log: `taken after the line's trade with ${speaker} came to nothing: its gives to ${speaker} are refused (${request})`, tradeCameToNothing: true, duringTrade: "came to nothing" };
  }
  if (open !== null) {
    return { kind: "taken", log: `taken during trade ${open} with ${speaker}: its gives to ${speaker} wait for the trade's hand-off (${request})`, duringTrade: open };
  }
  return { kind: "taken" };
}
