// What the agent does with one line it heard: the chat tier's decision, its reply, its trade, and the order it makes of a request.
import { parseActivity } from "../activities.ts";
import type { ChatDecision, ChatLine, Objective } from "../mind.ts";
import { sameWords } from "../mind.ts";
import { monotonicNow, wallTimeOf } from "../monotonic-clock.ts";
import { isGiveTo } from "../relations/handoff.ts";
import { askFromReply } from "../relations/heard-to-me.ts";
import { orderVerdict } from "../relations/order-refusal.ts";
import { reachOf, type TradeAsks } from "../relations/trading.ts";
import type { BotSnapshot, PlayerMessage } from "../runtime-client.ts";
import type { Heard } from "../inbox.ts";
import { decideHeard, isOtherAgent, namedIn, supersededBy, type ChatRoutingHost } from "./chat-routing.ts";
import { topWork } from "./stack.ts";
import type { Work } from "./work.ts";

/** What handling one line asks of the agent it belongs to. */
export interface HandleHost extends ChatRoutingHost {
  readonly stack: readonly Work[];
  readonly asks: TradeAsks;
  /** Puts the line in the chat history, and returns it. */
  remember(speaker: string, text: string): ChatLine;
  annotate(line: ChatLine, to: readonly string[]): void;
  /** `since`: when the message being answered was heard. Resolves once the line is sent. */
  speak(text: string, since: number, to: readonly string[], whisperTo: string | null, shout: boolean): Promise<void>;
  take(objective: Objective, whisperTo: string | null, duringTrade?: string): void;
  queue(objective: Objective, whisperTo: string | null, duringTrade?: string): void;
}

/** The part of a decision about a line that the order and the trade need: its speaker's trade, its taken form and its type. */
interface LineOutcome {
  readonly decision: ChatDecision;
  readonly lineDecision: ChatDecision;
  readonly routed: "act" | "later";
  readonly tradeId: string | null;
}

/**
 * Reacts to one incoming message. Returns once the reply is queued, not spoken, so "stop" is never stuck behind work.
 * `heard`: the message as the inbox gave it; when its speaker has said something since, the reply is dropped unspoken
 * (a "stop" still stops: only its line is dropped).
 */
export async function handleLine(host: HandleHost, message: PlayerMessage, heard?: Heard): Promise<void> {
  const heardAt = monotonicNow();
  host.lastHeard.set(message.username.toLowerCase(), heardAt);
  const { persona, log } = host.options;
  const line = host.remember(message.username, message.message);
  const talkedTo = host.whoWasNamed.note(message, heardAt);
  const named = namedIn(host, message);
  const chat = await decideHeard(host, message, heard, heardAt, talkedTo, named);
  if (chat === null) return;
  // `snapshot` is the chat call's start (the payment baseline of a trade it makes); `checked` is the world after the model call.
  const { decision, snapshot, checked, conversation, seenOfferId } = chat;
  const seen = { heardAt: wallTimeOf(heardAt), ...(seenOfferId !== undefined && { seenOfferId }) };
  // What they said of my requests counts even if the reply below is dropped: it was said.
  await host.relations?.answered(decision, message.username);
  const { route } = decision;
  const request = route === "act" || route === "later" ? ` ${JSON.stringify(decision.request)}` : "";
  log(`${message.username}: ${JSON.stringify(message.message)} -> ${route}${request}, say ${JSON.stringify(decision.say)}${decision.type === undefined ? "" : ` (${decision.type})`}`);
  // Whom it read the line as spoken to stays with the line: a follow-up is read in that light (live 2026-10-04:
  // "fix it now" after "Opus, Vex is going through the ocean" was taken by Vex).
  if (decision.to !== undefined) host.annotate(line, decision.to);
  // Its speaker went on while the model thought: this reply answers a state that is gone. The newest lines are read
  // next, with this one in the history (spec 2026-10-09-chat-handling, A).
  const superseded = supersededBy(host, message, heard);
  const talkId = conversation === undefined ? undefined : host.talks?.current?.id;
  host.options.journal?.({ kind: "chat", speaker: message.username, text: message.message, channel: message.channel, lines: heard?.lines ?? 1, ...(heard !== undefined && heard.dropped > 0 && { dropped: heard.dropped }), ...(heard !== undefined && heard.heldMs >= 1_000 && { heldMs: heard.heldMs }), route, say: decision.say, superseded, ...(talkId !== undefined && { conversation: talkId }), ...(decision.to !== undefined && { to: decision.to }), ...(decision.place !== undefined && { place: decision.place }), ...(decision.startsNow !== undefined && { startsNow: decision.startsNow }), ...(decision.type !== undefined && { type: decision.type }) });
  if (superseded) {
    await dropSuperseded(host, decision, message.username, snapshot, seen);
    return;
  }
  // A line naming nobody, soon after its speaker named another character, is that character's unless the model read
  // it as spoken to her or to everyone (owner, 2026-10-11, L6: Ayla answered "thanks, no rush" meant for Vex although
  // the fact was in her input).
  if (talkedTo !== undefined && (decision.to ?? []).every((name) => name.toLowerCase() !== persona.username.toLowerCase() && name.toLowerCase() !== "everyone")) {
    log(`  ignored: ${message.username} was talking to ${talkedTo.name} ${talkedTo.secondsAgo} s ago, the line names nobody and is not read as spoken to ${persona.username} or everyone`);
    return;
  }
  // A "stop" that carries a request stops what runs (if anything), then the request is the order (live 2026-10-11, L7:
  // "release that area" routed stop while idle, and the area stayed; a busy agent dropped it the same way).
  const carriesRequest = decision.route === "stop" && decision.request.trim() !== "";
  const routed = carriesRequest ? "act" : decision.route;
  if (routed === "ignore") return;
  // A whisper is answered by whisper (and so is the order it gives), anything else in public chat.
  const whisperTo = message.channel === "whisper" ? message.username : null;
  const said = host.speak(decision.say, heard?.readAt ?? heardAt, [message.username], whisperTo, decision.shout === true); // typing counts from the read time: the burst window and the model's wait were typing (spec 2026-11-18 D4)
  openRequestsOnceSaid(host, said, decision, whisperTo, snapshot);
  // A stop with a request stops the work before `decided`: the give the line's own trade pushes is no work to stop (spec 2026-11-07-gift-asked-for D4).
  if (carriesRequest && host.stack.length > 0) host.stopAndRest(message.username);
  const lineDecision = host.relations?.withoutRestatement(decision, message.username, seen.heardAt) ?? decision;
  const tradeId = lineDecision.trade === undefined ? null : await host.relations?.decided(lineDecision, message.username, snapshot, { ...seen, asked: routed === "act" || routed === "later" }) ?? null;
  // A trade proposed to the bot (or agreed with it) ends the pause of its own trading objectives.
  if (tradeId !== null) host.asks.resume();
  if (conversation !== undefined) spokeInConversation(host, decision, message.username);
  // Its speaker went on during the trade decision (a stop word, say): the line answers a state that is gone, its order is not taken (the stop route below still stops).
  if ((routed === "act" || routed === "later") && supersededBy(host, message, heard)) return void log("  superseded during the trade decision: no order taken");
  // A stop ends the speaker's work and the character's own goals only, the other players' queued orders stay, with or
  // without a request (owner, 2026-10-16, review R18, SF4: "a stop ends only the speaker's work").
  if (routed === "stop") host.stopAndRest(message.username);
  // A line that made a trade is that trade's action: its hand-off is what she does, not an order on top whose give the trade never sees (live 2026-10-19, B1).
  if ((routed === "act" || routed === "later") && tradeId !== null) {
    log(`the request is trade ${tradeId}: no order taken (${JSON.stringify(decision.request)})`);
    return;
  }
  if (routed !== "act" && routed !== "later") return;
  takeRequest(host, message, { decision, lineDecision, routed, tradeId }, whisperTo, checked ?? snapshot);
}

/**
 * The request of an `act` or `later` reply becomes an order of its speaker (their authority is the order's), unless
 * the speaker is not obeyed, it is already on the stack, or they already hold the most requests (spec
 * 2026-11-18-chat-flood-bounds D4). `world`: the last look at the world, for a trade errand's reach.
 */
function takeRequest(host: HandleHost, message: PlayerMessage, line: LineOutcome, whisperTo: string | null, world: BotSnapshot): void {
  const { decision, lineDecision, routed, tradeId } = line;
  const { log, persona } = host.options;
  const asked = { text: decision.request, requester: message.username, purpose: parseActivity(decision.work), ...(decision.place !== undefined && { place: decision.place }) };
  // No trade errand across the map: a bot out of reach is told to come (relations block); players are obeyed at any distance.
  if (asked.purpose === "trading" && isOtherAgent(host, message.username) && !reachOf(message.username, world, persona.settings.relations.tradeReach).inReach) {
    log(`not taken: ${message.username} is too far away to trade with (${JSON.stringify(decision.request)})`);
    return;
  }
  const verdict = orderVerdict(host.relations, lineDecision, message.username, asked.purpose, tradeId);
  if (verdict.kind === "refused") return void log(verdict.log);
  // A request already on her stack is not taken again (live 2026-10-04: "thanks, no rush" while she fetched for
  // Opus's house came back as "later" with the same request, and a second house order was queued under the first).
  if (host.stack.some(({ objective }) => objective.requester === asked.requester && sameWords(objective.text, asked.text))) return void log(`already on "${asked.text}" for ${asked.requester}`);
  const { openOrdersPerRequester: max } = persona.settings.chat;
  const open = host.openOrdersOf(message.username);
  if (open >= max) {
    log(`not taken: ${message.username} already holds ${open} requests (max ${max})`);
    return host.options.journal?.({ kind: "order_refused", speaker: message.username, text: asked.text, reason: "open_orders", open, max });
  }
  if (verdict.log !== undefined) log(verdict.log);
  const order: Objective = verdict.tradeCameToNothing === true ? { ...asked, tradeCameToNothing: true } : asked;
  // The partner's give runs first: the order was let through because of the trade (spec 2026-11-08-trading-p2-fixes D3).
  if (verdict.duringTrade !== undefined && isGiveTo(topWork(host.stack)?.objective.handoff, message.username)) host.queue(order, whisperTo, verdict.duringTrade);
  else if (routed === "act") host.take(order, whisperTo, verdict.duringTrade);
  else takeAfterOwnGoal(host, order, whisperTo, verdict.duringTrade);
}

/** A "later" request: taken at once over the character's own goal, queued behind work done for someone. */
function takeAfterOwnGoal(host: HandleHost, objective: Objective, whisperTo: string | null, duringTrade?: string): void {
  // Owner rule (2026-10-01): a player's request always comes before the character's own goal. The prompt says so,
  // but qwen3 still answered "later" to a plain request while on its own goal, so the stack enforces it: "later"
  // only waits behind work done for someone.
  const top = topWork(host.stack);
  if (top === undefined || top.objective.requester === null) host.take(objective, whisperTo, duringTrade);
  else host.queue(objective, whisperTo, duringTrade);
}

/** The line answers a state that is gone and is dropped, but a stop is not: it was meant, and the newer line (read next) does not take it back; so is a bot's accept or decline of the offer it read, while that offer stands (a player's, a propose and a cancel are dropped: owner 2026-10-31). */
async function dropSuperseded(host: HandleHost, decision: ChatDecision, speaker: string, snapshot: BotSnapshot, seen: { readonly heardAt: number; readonly seenOfferId?: string }): Promise<void> {
  if (decision.route === "stop") {
    host.options.log("  superseded: its speaker said something since; the line is dropped but the stop is kept");
    host.stopAndRest(speaker);
  } else {
    host.options.log("  superseded: its speaker said something since, the reply is dropped");
  }
  const action = decision.trade?.action;
  if ((action !== "accept" && action !== "decline") || !isOtherAgent(host, speaker) || host.relations?.offerStillStands(speaker, seen.seenOfferId) !== true) return;
  host.options.log(`  superseded: the line is dropped, its trade ${action} is kept`);
  if (await host.relations.decided(decision, speaker, snapshot, seen) !== null) host.asks.resume();
}

/** The ask in the reply becomes an open request when its line is sent, not when decided (typing runs seconds behind earlier speech: a line heard before that is no answer to it); a say that failed opens none. */
function openRequestsOnceSaid(host: HandleHost, said: Promise<void>, decision: ChatDecision, whisperTo: string | null, snapshot: BotSnapshot): void {
  const ask = askFromReply(decision);
  if (ask === null) return;
  void said.then(() => host.relations?.asked(ask.names, ask.what, whisperTo, snapshot), () => undefined);
}

/** Her line in a conversation counts in it; a goodbye (or a line after the cap) ends it. */
function spokeInConversation(host: HandleHost, decision: { readonly say: string; readonly close?: boolean }, answering: string): void {
  if (decision.say.trim() !== "") host.talks?.said(decision.close === true, answering, host.runSignal());
  else if (decision.close === true) host.talks?.end("goodbye", host.runSignal());
}
