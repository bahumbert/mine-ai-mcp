// The chat tier's reply: its JSON schema, who it speaks to, the decision a checked reply stands for, and the prompt's "type" bullet.
import { z } from "zod";
import { MESSAGE_TYPES, PLACES, ROUTES, type ChatDecision, type ChatInput, type MessageType, type Place } from "./mind.ts";
import { relationReplyFields } from "./relations/prompts.ts";

export const chatReplySchema = z.object({
  // Asked first in every reply; one without it is read as saying nothing about who (the check below then passes).
  spoken_to: z.union([z.string(), z.array(z.string())]).default([]),
  // What the message asks of its listeners, "" for a remark: a line to everyone that asks nothing is not answered when
  // it does not name her (owner 2026-10-09; bench: "pareil, je vois plus les skins" amid others' chat read as to everyone).
  asks: z.string().default(""),
  // What the message is (spec 2026-11-18-complaint-not-order, live run 13: "you're destroying someone else's house" was
  // taken on as a levelling order): "act" and "later" are held to a "request"; a missing one is sent back, never read as one.
  type: z.enum(MESSAGE_TYPES).optional(),
  // Named before "say" is written: told only to answer in the player's language, French lines got English answers
  // (live 2026-10-07, real world and local).
  language: z.string().default(""),
  work: z.string().default(""),
  say: z.string().default(""),
  // The model's own judgment of its line, in its own language: true when the line says she starts right now (spec
  // 2026-10-09-chat-handling, B: replaces an English regex over the line).
  starts_now: z.boolean().optional(),
  // Only offered when the server limits how far talk carries (Localized Chat): the line is shouted to everyone.
  shout: z.boolean().optional(),
  // Only offered inside a conversation: the line is a goodbye that ends it for her.
  close: z.boolean().optional(),
  // Only offered when relations are on: read by `relationReplyFields`, a malformed one is dropped.
  trade: z.unknown().optional(),
  // Only offered when relations are on: read by `relationReplyFields` (`parseAsks` / `parseMyRequest`), a malformed one is dropped.
  asks_of: z.unknown().optional(),
  asks_what: z.unknown().optional(),
  my_request: z.unknown().optional(),
  route: z.enum(ROUTES),
  // Where the request happens; the code writes the coordinates itself.
  place: z.enum(PLACES).optional(),
  request: z.string().default(""),
});

export type ChatReply = z.infer<typeof chatReplySchema>;

/** Who a line speaks to, as the chat tier read it: names, "everyone" or "unclear", trimmed, without "@". */
export function addressees(to: string | readonly string[]): string[] {
  return (typeof to === "string" ? to.split(",") : [...to]).map((name) => name.trim().replace(/^@/u, "")).filter((name) => name !== "");
}

/** Whether a line read as speaking to `to` is for this character: its name, everyone, or nobody in particular. */
export function speaksTo(to: readonly string[], username: string): boolean {
  return to.length === 0 || to.some((name) => ["everyone", "unclear", "you"].includes(name.toLowerCase()) || name.toLowerCase() === username.toLowerCase());
}

/**
 * Who a reply says the line speaks to. Whoever says a line is not one it speaks to (live 2026-10-03: in a conversation
 * with her, "no stop harvesting, this is important" was read as spoken to StarOr1, who said it, and ignored). Listed
 * alone, nobody is left: no one in particular, so it may be for her.
 */
export function readListeners(spokenTo: string | readonly string[], speaker: string): { given: string[]; listeners: string[]; to: string[] } {
  const given = addressees(spokenTo);
  const listeners = given.filter((name) => name.toLowerCase() !== speaker.toLowerCase());
  return { given, listeners, to: given.length > 0 && listeners.length === 0 ? ["unclear"] : listeners };
}

/** Whether the reply carries a trade the code accepts (relations on, a well-formed one): a `trade` key holding null, "none" or {} is none (task review 2026-11-19), so no exemption from the checks of an order. */
export function carriesTrade(input: ChatInput, reply: ChatReply): boolean {
  return relationReplyFields(input, reply).trade !== undefined;
}

/** The decision of a reply that passed every check; `type` is the one held for the line, else the reply's; `mayShout`: a server that limits talk, outside a conversation. */
export function chatDecisionOf(input: ChatInput, reply: ChatReply, to: readonly string[], type: MessageType | undefined, mayShout: boolean): ChatDecision {
  const acts = reply.route === "act" || reply.route === "later";
  const restated = reply.request.trim();
  // A stop that is not a request carries none: the agent would take it on as an order (spec 2026-11-18-complaint-not-order C4).
  const noRequest = reply.route === "stop" && type !== undefined && type !== "request";
  const inTalk = input.conversation !== undefined;
  return {
    ...(to.length > 0 && { to }),
    say: reply.say,
    route: reply.route,
    request: noRequest ? "" : acts ? withPlace(restated, reply.place, input) : restated,
    ...(type !== undefined && { type }),
    ...(input.persona.preferences !== undefined && { work: reply.work.trim() }),
    // Shouting is for calling someone over, never inside a conversation (spec 2026-10-18).
    ...(mayShout && reply.shout === true && { shout: true }),
    ...(inTalk && reply.close === true && { close: true }),
    ...(acts && reply.place !== undefined && { place: reply.place }),
    ...(acts && reply.starts_now !== undefined && { startsNow: reply.starts_now }), ...relationReplyFields(input, reply),
  };
}

/**
 * A request with where it happens written by the code, not the model: where the speaker stands (or that she cannot see
 * them), or where she stands. Any other place is the request's own words.
 */
function withPlace(request: string, place: Place | undefined, input: ChatInput): string {
  const { x, y, z } = input.snapshot.position;
  if (place === "you") return `${request} (at ${Math.floor(x)} ${Math.floor(y)} ${Math.floor(z)}, where you stand)`;
  if (place !== "speaker") return request;
  const speaker = input.snapshot.players.find((player) => player.username.toLowerCase() === input.message.username.toLowerCase());
  const at = speaker?.position;
  if (at === undefined || at === null) return `${request} (where ${input.message.username} is; you cannot see them from here)`;
  return `${request} (at ${Math.floor(at.x)} ${Math.floor(at.y)} ${Math.floor(at.z)}, where ${input.message.username} stands)`;
}

/** The chat prompt's "type" bullet: the four kinds of message, so only a request is taken on (spec 2026-11-18-complaint-not-order A). */
export function messageTypeInstructions(username: string): string {
  return `- "type": after "asks", what the message is, one of:
  "request" = it asks its listeners to do something or to hand something over, in any form: an order, a question whose
  answer is an act or a give ("can you get me wood?", "anyone got bread?"), a wish said to you ("${username}, I'd
  love a wall here"), a deal or an offer proposed to you or accepting one, saying yes to something you offered to do
  ("yes please" after "Want me to fetch logs?"), or asking you to stop;
  "question" = it asks for an answer only (what you carry, where you are, how you feel);
  "complaint" = it objects to something you or someone did or does, without asking for anything to be done;
  "remark" = anything else: news, a greeting, thanks, agreeing with what someone said, an answer, chit-chat.`;
}
