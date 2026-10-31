// Why an order from a speaker is not taken: its trade came to nothing, a trade or offer is open with them, or the roll said no.
import type { ChatDecision } from "../mind.ts";
import type { AgentRelations } from "./agent-relations.ts";

/**
 * The log line saying why an order (an `act`, a `later`, the request of a stop) from `speaker` is not taken; null when it is.
 * The line's own trade, when it made one, was handled before: here a trade the line carried came to nothing (its hand-off
 * is how items move, s3h: two bots swapped items outside any trade), a trade or offer is open with the speaker, or the
 * roll made for the speaker's mood said no (owner 2026-10-31; the model was told before it answered). No relations: taken.
 */
export function orderRefusal(relations: AgentRelations | null, decision: ChatDecision, speaker: string): string | null {
  if (relations === null) return null;
  const request = JSON.stringify(decision.request);
  if (decision.trade !== undefined || decision.tradeDropped === true) return `not taken: the line's trade with ${speaker} came to nothing (${request})`;
  const open = relations.tradeOpenWith(speaker);
  if (open !== null) return `not taken: ${speaker} and I have trade ${open} open; its hand-off is how items move (${request})`;
  const mood = relations.obeys(speaker);
  if (mood === null || mood.obeys) return null;
  return `not taken: ${speaker} rated ${Math.round(relations.rating(speaker))}, chance ${Math.round(mood.chance * 100)} %, rolled no (${request})`;
}
