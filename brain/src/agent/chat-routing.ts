// Who the agent hears, what a line it hears is read as, and the chat tier's decision about it (waiting for a model server that is away).
import { sleepMs } from "../wall-timers.ts";
import type { AgentOptions } from "../agent.ts";
import { ModelUnavailable } from "../chat-model.ts";
import type { ConversationController } from "../conversation/controller.ts";
import { heardFarAway, lineDistance, noteNoPosition, type NoPositionSince } from "../conversation/state.ts";
import type { Heard, Inbox } from "../inbox.ts";
import { namesWord } from "../llm-mind.ts";
import { CHAT_RETRY_MS } from "../model-wait.ts";
import { monotonicNow, wallTimeOf } from "../monotonic-clock.ts";
import type { ChatDecision, ChatInput, ChatLine, ConversationFacts, KnownPlace } from "../mind.ts";
import type { AgentRelations } from "../relations/agent-relations.ts";
import { lineIsToMe, markHeardAt } from "../relations/heard-to-me.ts";
import type { BotSnapshot, PlayerMessage, ProtectedArea } from "../runtime-client.ts";
import { isStopLine, stopLineIsMine } from "../stop-line.ts";
import type { WhoWasNamed } from "../who-was-named.ts";

/** What the talk and the chat routing remember between lines: who is online, the last look at the world, who was a member before their line. */
export interface TalkState {
  /** Who was online at the last look, as spelled in the game: the names a line may hold. */
  onlineNames: readonly string[];
  /** The last look at the world by the conversation check: where players stood when a line carries no distance. */
  lastLook: BotSnapshot | null;
  /** Who the looks list with no position, since when: a line from one of them for 3 s is heard as from beyond talk range. */
  readonly noPositionSince: NoPositionSince;
  /** Whether each speaker (lowercase) was already in the conversation when their last line was heard. */
  readonly memberBeforeLine: Map<string, boolean>;
}

/** What the chat routing reads from the agent it belongs to. `runSignal` is a getter: `Agent.run` replaces the signal at start. */
export interface ChatRoutingHost {
  readonly options: AgentOptions;
  readonly history: readonly ChatLine[];
  readonly inbox: Inbox;
  readonly areas: readonly ProtectedArea[];
  /** Its conversations; null when the brain runs without them. */
  readonly talks: ConversationController | null;
  /** Its relations and trades; null when `settings.relations.enabled` is false. */
  readonly relations: AgentRelations | null;
  readonly state: TalkState;
  readonly whoWasNamed: WhoWasNamed;
  /** When each player (lower case) last said anything. */
  readonly lastHeard: Map<string, number>;
  activity(): string;
  knownPlaces(): KnownPlace[];
  /** Whether the objective on top of the stack is an order from someone. */
  orderOnTop(): boolean;
  /** The requests on the stack asked by `name` (any case). */
  openOrdersOf(name: string): number;
  /** The line is the speaker's stop: ends their work and rests (see `Agent.stopAndRest`). */
  stopAndRest(speaker: string): void;
  /** Counts one more failure of the model server in a row and returns how long to wait before asking again. */
  modelFailed(error: ModelUnavailable): number;
  resetModelFailures(): void;
  runSignal(): AbortSignal;
}

/** What the chat tier decided about a line, with the snapshot and conversation it was made in (`checked`: the world its trade was last checked on, read after the model call). */
export interface HeardDecision {
  readonly decision: ChatDecision;
  readonly snapshot: BotSnapshot;
  readonly checked?: BotSnapshot;
  readonly conversation: ConversationFacts | undefined;
  readonly seenOfferId?: string;
}

/** Whether the name is another agent of the project (not a player). */
export function isOtherAgent(host: ChatRoutingHost, name: string): boolean {
  return host.options.otherAgents.names().some((other) => other.toLowerCase() === name.toLowerCase());
}

/** Whether this character listens to the player: its `listensTo` is empty or holds them. */
export function listensToPlayer(host: ChatRoutingHost, username: string): boolean {
  const { listensTo } = host.options.persona;
  return listensTo.length === 0 || listensTo.some((name) => name.toLowerCase() === username.toLowerCase());
}

/** The characters and players a line holds as words (not its speaker), as spelled in the game. */
export function namedIn(host: ChatRoutingHost, message: PlayerMessage): string[] {
  const { persona, otherAgents, knownNames } = host.options;
  const candidates = [persona.username, ...otherAgents.names(), ...(knownNames ?? []), ...host.state.onlineNames, ...(host.talks?.current?.members ?? [])];
  const seen = new Set<string>([message.username.toLowerCase()]);
  return candidates.filter((name) => {
    if (seen.has(name.toLowerCase()) || !namesWord(message.message, name)) return false;
    seen.add(name.toLowerCase());
    return true;
  });
}

/** Whether a player's line came from within talk range: its distance, else where the last look put them. */
function withinTalkRange(host: ChatRoutingHost, message: PlayerMessage): boolean {
  const range = host.options.localizedChat?.range ?? host.options.persona.settings.conversation.stayingDistance;
  const distance = lineDistance(message, host.state.lastLook);
  return distance !== undefined && distance <= range;
}

/**
 * Who the agent hears at all; whether a message is meant for it is the chat tier's call (no name needed). Another
 * agent is heard only inside a conversation: a member of it, or a line naming this character or a member (an opening
 * or a join, see {@link AgentOptions.otherAgents}).
 */
function hears(host: ChatRoutingHost, message: PlayerMessage, named: readonly string[]): boolean {
  const speaker = message.username.toLowerCase();
  const agent = isOtherAgent(host, message.username);
  if (!agent && !listensToPlayer(host, message.username)) return false;
  // A line naming her makes its speaker a member: whether they already were is what a request of theirs is judged by.
  host.state.memberBeforeLine.set(speaker, host.talks?.isMember(message.username) === true);
  host.talks?.heard(message.username, message.message, named, message.channel, !agent && withinTalkRange(host, message));
  return !agent || host.talks?.isMember(message.username) === true;
}

/** Whether the message's speaker went on, or in a conversation any member spoke, since it was taken (its reply answers a state that is gone). */
export function supersededBy(host: ChatRoutingHost, message: PlayerMessage, heard: Heard | undefined): boolean {
  if (heard === undefined) return false;
  const self = host.options.persona.username.toLowerCase();
  const members = host.talks?.current?.members.filter((name) => name.toLowerCase() !== self) ?? [];
  return host.inbox.superseded(message.username, heard.seq) || host.inbox.spokeSince(members, heard.seq);
}

/**
 * In a conversation of three or more, not every member answers every line (spec 2026-10-18): a line naming members
 * but not her is only recorded; a line naming nobody is answered after a random wait, unless a member spoke meanwhile.
 * True: go on to the chat tier.
 */
async function conversationGate(host: ChatRoutingHost, message: PlayerMessage, heard: Heard | undefined, named: readonly string[]): Promise<boolean> {
  const talk = host.talks?.current;
  if (talk === null || talk === undefined || talk.members.length < 3) return true;
  const { persona, log } = host.options;
  const self = persona.username.toLowerCase();
  if (message.addressed || message.channel === "whisper" || named.some((name) => name.toLowerCase() === self)) return true;
  if (named.some((name) => host.talks?.isMember(name))) {
    log(`  group: ${message.username} named ${named.join(", ")}, not me: recorded, no answer`);
    return false;
  }
  const [from, to] = persona.settings.conversation.groupReplyJitterMs;
  await sleepMs(from + (host.options.random ?? Math.random)() * (to - from), host.runSignal()).catch(() => undefined);
  const others = (host.talks?.current?.members ?? []).filter((name) => name.toLowerCase() !== self);
  if (heard !== undefined && host.inbox.spokeSince(others, heard.seq)) {
    log("  group: a member spoke meanwhile, no answer");
    return false;
  }
  return true;
}

/** Whether the line is heard, may be answered now, and what the chat tier decides; the speaker counts as waiting meanwhile (requests made to them are not ignored). */
export async function decideHeard(host: ChatRoutingHost, message: PlayerMessage, heard: Heard | undefined, heardAt: number, talkedTo: { name: string; secondsAgo: number } | undefined, named: readonly string[]): Promise<HeardDecision | null> {
  const release = host.inbox.hold(message.username);
  const call = { made: false };
  try {
    if (!hears(host, message, named)) return null;
    if (!(await conversationGate(host, message, heard, named))) return null;
    const chat = await decideChat(host, message, heard, heardAt, talkedTo, call);
    // Marked before the release below: the waiting hold must not end before the mark, or the request expires unheard.
    // A tier that could not read the line gives the speaker the benefit of the doubt; a line refused above marks nothing.
    const markAt = markHeardAt(chat, { aborted: host.runSignal().aborted, readAt: heard?.readAt ?? heardAt, justTalkedToAnother: talkedTo !== undefined, self: host.options.persona.username.toLowerCase() });
    if (markAt !== null) host.relations?.heardFrom(message.username, wallTimeOf(markAt));
    return chat;
  } finally {
    release();
    if (heard !== undefined && !call.made) host.options.speakerBudget?.refund(message.username); // the token the inbox took bought no chat model call
  }
}

/**
 * The chat tier's decision about `message` (a trade in it checked), with the snapshot and conversation it was made
 * in, or null when there is none to act on. A model server that does not answer is waited for and asked again while
 * the line is under {@link CHAT_RETRY_MS} old and its speaker has said nothing since (a stale reply is dropped unspoken
 * anyway); any other failure drops the line, as it always did.
 */
async function decideChat(host: ChatRoutingHost, message: PlayerMessage, heard: Heard | undefined, heardAt: number, talkedTo: { name: string; secondsAgo: number } | undefined, call: { made: boolean }): Promise<HeardDecision | null> {
  const { persona, mind, log, runtime } = host.options;
  const { state } = host;
  for (;;) {
    try {
      const snapshot = await runtime.status();
      state.onlineNames = snapshot.players.map((player) => player.username);
      noteNoPosition(state.noPositionSince, snapshot.players, monotonicNow());
      const conversation = host.talks?.facts();
      const claimEveryoneLine = host.options.everyone?.claimFor(message, snapshot, persona.username, heard?.lastLine ?? message.message);
      // A shout with no server distance is as far as the speaker stands in this snapshot: the model is told how far it came (a whisper carries any distance, so it is not).
      const distance = lineDistance(message, snapshot);
      const heardMessage = message.channel === "chat" && message.distance === undefined && distance !== undefined ? { ...message, distance } : message;
      const farAway = message.channel === "chat" && heardFarAway(message, snapshot, state.noPositionSince, monotonicNow());
      const open = host.openOrdersOf(message.username);
      const input: ChatInput = { persona, message: heardMessage, ...(farAway && { heardFarAway: true }), fromAgent: isOtherAgent(host, message.username), ...(heard !== undefined && heard.dropped > 0 && { unreadLines: heard.dropped }), ...(open > 0 && { speakerOrders: { open, max: persona.settings.chat.openOrdersPerRequester } }), history: host.history.slice(0, -1), snapshot, activity: host.activity(), places: host.knownPlaces(), areas: [...host.areas], canWait: host.orderOnTop(), knownNames: host.options.knownNames ?? [], ...(talkedTo !== undefined && { talkedTo }), ...(conversation !== undefined && { conversation }), ...(claimEveryoneLine !== undefined && { claimEveryoneLine }), ...(host.relations !== null && { relations: host.relations.chatBlock(message.username, conversation?.others ?? [], snapshot) }) };
      call.made = true; // a call may go out (and fail) below: the speaker's token stays spent, a retry takes no second one
      let decision = await mind.chat(input, host.runSignal());
      call.made = decision.asked !== false;
      let checked: BotSnapshot | undefined;
      if (host.relations !== null && decision.trade !== undefined) ({ decision, snapshot: checked } = await host.relations.checkedTrade(decision, input, { speaker: message.username, heardAt: wallTimeOf(heardAt), snapshot, signal: host.runSignal() }));
      host.resetModelFailures();
      return { decision, snapshot, ...(checked !== undefined && { checked }), conversation, ...(input.relations?.seenOfferId !== undefined && { seenOfferId: input.relations.seenOfferId }) };
    } catch (error) {
      if (host.runSignal().aborted) return null;
      if (!(error instanceof ModelUnavailable)) {
        log(`chat tier failed on "${message.message}": ${String(error)}`);
        return null;
      }
      const delay = host.modelFailed(error);
      const superseded = heard !== undefined && host.inbox.superseded(message.username, heard.seq);
      if (superseded || monotonicNow() - heardAt >= CHAT_RETRY_MS) {
        log(`chat tier unavailable, "${message.message}" dropped (${superseded ? "its speaker said something since" : "no answer in time"}): ${error.message}`);
        return null;
      }
      await sleepMs(delay, host.runSignal()).catch(() => undefined);
    }
  }
}

/** One line the poll read: noted as heard, offered to the relations and the shared chat, and queued for the chat tier. Returns false when it is not to be queued (its own line coming back). */
export function takeMessage(host: ChatRoutingHost, message: PlayerMessage): boolean {
  const { persona, everyone } = host.options;
  // Its own line coming back is never a member's: it must not reset a silence or wake its own chat.
  if (message.username.toLowerCase() === persona.username.toLowerCase()) return false;
  host.lastHeard.set(message.username.toLowerCase(), monotonicNow());
  host.relations?.trades.heardLine(message.username, Date.now(), message.distance ?? null);
  // Only a line spoken to me answers an ask (owner 2026-10-29); the ones the code cannot tell are read by the chat tier (decideHeard).
  if (lineIsToMe(message, { self: persona.username.toLowerCase(), isMember: host.talks?.isMember(message.username) === true, named: namedIn(host, message) })) host.relations?.heardFrom(message.username);
  if (message.channel === "chat") everyone?.heard(message.username, message.message, persona.username, message.distance ?? null);
  stopAtOnceOnStopWord(host, message);
  host.inbox.push(message);
  return true;
}

/** A line that is only an owner's stop word, and is hers, ends the speaker's work at once, with no model call and no speaker token; the line still goes to the chat tier. */
function stopAtOnceOnStopWord(host: ChatRoutingHost, message: PlayerMessage): void {
  const { persona, stopWords, log, journal } = host.options;
  const named = namedIn(host, message);
  if (!isStopLine(message.message, stopWords ?? [], named)) return;
  const heard = isOtherAgent(host, message.username) ? host.talks?.isMember(message.username) === true : listensToPlayer(host, message.username);
  if (!stopLineIsMine({ named, self: persona.username, channel: message.channel, heard, speakerHasOrder: host.openOrdersOf(message.username) > 0, talkedToOther: host.whoWasNamed.peek(message, monotonicNow()) !== undefined || host.whoWasNamed.lastNamedIsOther(host.inbox.waitingLines(message.username)) })) return;
  host.stopAndRest(message.username);
  log(`stop word from ${message.username}: stopped at once (${host.inbox.dropWaitingFrom(message.username)} earlier lines dropped)`);
  journal?.({ kind: "stop", speaker: message.username, text: message.message, channel: message.channel });
}
