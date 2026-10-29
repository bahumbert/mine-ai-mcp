// Which lines are spoken to me, and the ask my own reply makes: the rules the agent applies to a heard line (owner 2026-10-29: only a line spoken to me answers my request). Pure: the agent gathers the facts and acts on the answer.
import type { ChatDecision } from "../mind.ts";
import type { PlayerMessage } from "../runtime-client.ts";

/** What the agent knows about a line before the chat tier reads it. `self` is lower case. */
export interface LineFacts {
  readonly self: string;
  /** The speaker is a member of the conversation I am in. */
  readonly isMember: boolean;
  /** The characters and players the line names as words (not its speaker). */
  readonly named: readonly string[];
}

/** Whether code alone knows the line is spoken to me: a whisper, my name as a word, or a talk partner naming no other character. */
export function lineIsToMe(message: PlayerMessage, facts: LineFacts): boolean {
  if (message.channel === "whisper" || message.addressed) return true;
  if (!facts.isMember) return false;
  return facts.named.every((name) => name.toLowerCase() === facts.self);
}

/** Whether the chat tier's reading puts the line to me: it answers one of my requests, or it is not an ignored line and names me, or nobody when the speaker did not just talk to another character (`"everyone"` alone is not me). */
export function readAsToMe(decision: ChatDecision, facts: { readonly self: string; readonly justTalkedToAnother: boolean }): boolean {
  if (decision.myRequest !== undefined) return true;
  if (decision.route === "ignore") return false;
  // A nameless line soon after its speaker named another character is that character's (the same rule `handle` drops the reply by).
  return (decision.to === undefined && !facts.justTalkedToAnother) || (decision.to ?? []).some((name) => name.toLowerCase() === facts.self);
}

/**
 * The time to mark the speaker as having spoken to me, or null for no mark. A tier that could not read the line (`chat`
 * null) gives the speaker the benefit of the doubt, unless the run is over; a line refused before the tier marks nothing
 * (the caller does not ask).
 */
export function markHeardAt(
  chat: { readonly decision: ChatDecision } | null,
  facts: { readonly aborted: boolean; readonly readAt: number; readonly justTalkedToAnother: boolean; readonly self: string },
): number | null {
  const toMe = chat === null ? !facts.aborted : readAsToMe(chat.decision, facts);
  return toMe ? facts.readAt : null;
}

/** The ask a reply makes of someone (whom, and what; "something" when it gave none), or null when it asks nobody or says nothing: a say that is empty opens no request. */
export function askFromReply(decision: Pick<ChatDecision, "say" | "asksOf" | "asksWhat">): { readonly names: readonly string[]; readonly what: string } | null {
  if (decision.asksOf === undefined || decision.say.trim() === "") return null;
  return { names: decision.asksOf, what: decision.asksWhat ?? "something" };
}
