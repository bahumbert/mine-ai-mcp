// Builds the character's relations and conversations from what the agent gives them (a hand-off, the chat line, a memory), nothing more.
import type { Body } from "../body.ts";
import { ConversationController } from "../conversation/controller.ts";
import type { Inbox } from "../inbox.ts";
import type { ChatLine } from "../mind.ts";
import type { Memory } from "../memory.ts";
import { monotonicNow } from "../monotonic-clock.ts";
import { AgentRelations } from "../relations/agent-relations.ts";
import { describeLacks } from "../relations/chat-trade.ts";
import type { Handoff } from "../relations/handoff.ts";
import type { AgentOptions } from "./agent-options.ts";
import type { TalkState } from "./chat-routing.ts";
import { topWork } from "./stack.ts";
import type { Work } from "./work.ts";

/** What the relations and conversations are made from. */
export interface TalkSetupHost {
  readonly options: AgentOptions;
  readonly body: Body;
  readonly inbox: Inbox;
  readonly history: readonly ChatLine[];
  readonly stack: readonly Work[];
  readonly state: TalkState;
  takeHandoff(handoff: Handoff): void;
  speak(text: string, since: undefined, to: readonly string[] | undefined, whisperTo: string | null, shout: boolean | undefined): Promise<void>;
  memorize(memory: Memory): Promise<boolean>;
}

/** Its relations and trades (spec 2026-10-19-relations-trading-design); null when `settings.relations.enabled` is false. */
export function createRelations(host: TalkSetupHost): AgentRelations | null {
  const { options, state } = host;
  const { persona, localizedChat } = options;
  if (!persona.settings.relations.enabled) return null;
  return new AgentRelations({
    persona, mind: options.mind, runtime: options.runtime, body: host.body, takeHandoff: (h) => host.takeHandoff(h),
    isAgent: (name) => options.otherAgents.names().some((other) => other.toLowerCase() === name.toLowerCase()),
    hearingRange: localizedChat?.range ?? persona.settings.conversation.stayingDistance,
    isOnline: (name) => state.onlineNames.some((online) => online.toLowerCase() === name.toLowerCase()),
    waitingFrom: (name) => host.inbox.hasFrom(name),
    lacks: (inventory) => describeLacks(topWork(host.stack)?.wanted ?? [], inventory ?? state.lastLook?.inventory ?? []),
    journal: (event) => options.journal?.(event), log: (line) => options.log(line),
    ...(options.tradeBoard !== undefined && { board: options.tradeBoard }),
    ...(options.obeyRandom !== undefined && { obeyRandom: options.obeyRandom }),
  });
}

/** Its conversations (spec 2026-10-18-conversations-design); null when the brain runs without them. */
export function createTalks(host: TalkSetupHost, relations: AgentRelations | null): ConversationController | null {
  const { options } = host;
  const { conversations, persona, localizedChat } = options;
  if (conversations === undefined) return null;
  return new ConversationController({
    self: persona.username,
    persona,
    mind: options.mind,
    budget: conversations.budget,
    modelFree: conversations.modelFree,
    ...(conversations.waitForModel !== undefined && { waitForModel: conversations.waitForModel }),
    talkRange: localizedChat?.range ?? persona.settings.conversation.stayingDistance,
    localized: localizedChat !== undefined,
    random: options.random ?? Math.random,
    now: monotonicNow, wallNow: () => Date.now(),
    speak: (text, to, whisperTo, shout) => host.speak(text, undefined, to, whisperTo, shout),
    journal: (event) => options.journal?.(event),
    memorize: (talk) => host.memorize(talk),
    log: (line) => options.log(line),
    history: () => host.history,
    ...(relations !== null && { relations: relations.forConversations() }),
  });
}
