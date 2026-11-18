// The content checks a chat-tier reply must pass before it is read: a reply that contradicts the facts the prompt gave goes back.
import type { ChatInput, Route } from "./mind.ts";

/** A content check refusing a well-formed reply: it goes back with the reason, outside the format budget. */
export class SendBack extends Error {}

/** What the chat tier's reply says about whom it speaks to, and what was read from the line and the history about it. */
export interface ReplyFacts {
  /** The addressees as read (the speaker left out; `unclear` when only the speaker was listed). */
  readonly to: readonly string[];
  readonly given: readonly string[];
  readonly listeners: readonly string[];
  /** The characters the message calls by name, and who the speaker's previous line answered, as the prompt told it. */
  readonly called: readonly string[];
  readonly answering: string | null;
  readonly canWait: boolean;
}

/**
 * A reply that contradicts the facts the prompt gave goes back with the reason (spec 2026-10-09-chat-handling, B,
 * ADR-017): only the reply's own fields are read, never what the player wrote. Throws {@link SendBack}.
 */
export function checkReplyAgainstFacts(reply: { readonly route: Route }, input: ChatInput, facts: ReplyFacts): void {
  const { to, given, listeners, called, answering, canWait } = facts;
  const self = input.persona.username.toLowerCase();
  // Answering a line it reads as spoken to her by name ("everyone"/"unclear" do not count): held to the facts below.
  const answersAsHers = reply.route !== "ignore" && to.some((name) => name.toLowerCase() === self);
  // The message calls others by name and names her without calling her: a reply that speaks to her and answers it is
  // the misreading the facts were given against (bench 2026-10-09, French). Taking an order on is not held to it:
  // "Ayla, get wood and Vex mine stone" gives Vex an order with no comma after his name (bench: Vex 0/3 when held).
  if (answersAsHers && reply.route !== "act" && reply.route !== "later" && called.length > 0) {
    throw new SendBack(`"spoken_to" includes you, but the message calls ${called.join(", ")} by name and names you without calling you: it speaks to ${called.join(", ")}, about you; "route" is "ignore"`);
  }
  // The line answers someone else who just spoke to its speaker, and names nobody: a reply that speaks to her and
  // answers it ignores the fact given in the prompt (bench 2026-10-09, "ok j'arrive").
  if (answersAsHers && answering !== null) {
    throw new SendBack(`"spoken_to" includes you, but this message names nobody and ${answering} spoke to ${input.message.username} just before it: it answers ${answering}, not you; "route" is "ignore"`);
  }
  // Only her own name, or a list that named nobody but the speaker, means her: "everyone"/"unclear" lines stay hers
  // to let pass (the bench: held to them too, she answered every line to "Opus").
  const named = to.some((name) => name.toLowerCase() === self) || (given.length > 0 && listeners.length === 0);
  if (reply.route === "ignore" && named) {
    throw new SendBack(`"spoken_to" is ${JSON.stringify(to)}, which includes you: answer it ("talk", "say" may be ""), take it on, or stop; never "ignore"`);
  }
  if (reply.route === "later" && !canWait) throw new SendBack(`"later" is not a route now: you work for nobody else, so a request is "act"`);
}
