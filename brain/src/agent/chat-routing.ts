// Who the agent hears, and the chat tier's decision about each line it hears (waiting for a model server that is away).
import { setTimeout as sleep } from "node:timers/promises";
import type { AgentOptions } from "../agent.ts";
import { ModelUnavailable } from "../chat-model.ts";
import type { Heard, Inbox } from "../inbox.ts";
import { CHAT_RETRY_MS } from "../model-wait.ts";
import { monotonicNow } from "../monotonic-clock.ts";
import type { ChatDecision, ChatLine, KnownPlace } from "../mind.ts";
import type { PlayerMessage, ProtectedArea } from "../runtime-client.ts";

/** What the chat routing reads from the agent it belongs to. `runSignal` is a getter: `Agent.run` replaces the signal at start. */
export interface ChatRoutingHost {
  readonly options: AgentOptions;
  readonly history: readonly ChatLine[];
  readonly inbox: Inbox;
  readonly areas: readonly ProtectedArea[];
  activity(): string;
  knownPlaces(): KnownPlace[];
  /** Whether the objective on top of the stack is an order from someone. */
  orderOnTop(): boolean;
  /** Counts one more failure of the model server in a row and returns how long to wait before asking again. */
  modelFailed(error: ModelUnavailable): number;
  resetModelFailures(): void;
  runSignal(): AbortSignal;
}

/**
 * The chat tier's decision about `message`, or null when there is none to act on. A model server that does not
 * answer is waited for and asked again while the line is under {@link CHAT_RETRY_MS} old and its speaker has said
 * nothing since (a stale reply is dropped unspoken anyway); any other failure drops the line, as it always did.
 */
export async function decideChat(host: ChatRoutingHost, message: PlayerMessage, heard: Heard | undefined, heardAt: number, talkedTo: { name: string; secondsAgo: number } | undefined): Promise<ChatDecision | null> {
  const { persona, mind, log } = host.options;
  for (;;) {
    try {
      const snapshot = await host.options.runtime.status();
      const decision = await mind.chat({ persona, message, history: host.history.slice(0, -1), snapshot, activity: host.activity(), places: host.knownPlaces(), areas: [...host.areas], canWait: host.orderOnTop(), knownNames: host.options.knownNames ?? [], ...(talkedTo !== undefined && { talkedTo }) }, host.runSignal());
      host.resetModelFailures();
      return decision;
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
      await sleep(delay, undefined, { signal: host.runSignal() }).catch(() => undefined);
    }
  }
}

/**
 * Who the agent hears at all; whether a message is meant for it is the chat tier's call (no name needed).
 * Other agents are never answered (see {@link AgentOptions.otherAgents}).
 */
export function listensTo(host: ChatRoutingHost, username: string): boolean {
  const { persona } = host.options;
  const speaker = username.toLowerCase();
  if (host.options.otherAgents.names().some((name) => name.toLowerCase() === speaker)) return false;
  return persona.listensTo.length === 0 || persona.listensTo.some((name) => name.toLowerCase() === speaker);
}
