import type { Bot, BotEvents } from "mineflayer";
import { defineAction, type ActionContext } from "../action.js";
import { markdownCodeBlock } from "../markdown.js";
import {
  parseSendMessageRequest,
  sendMessageAnnotations,
  sendMessageOutcomes,
  SEND_MESSAGE,
  SEND_MESSAGE_DESCRIPTION,
  sendMessageInputSchema,
  sendMessageResultSchema,
  type SendMessageRequest,
  type SendMessageResult,
} from "./contract.js";

const MESSAGE_ECHO_TIMEOUT_MS = 5_000;

/** The translation key of the line the server sends a whisperer, "You whisper to <name>: <text>" in the client's language. */
const OUTGOING_WHISPER_KEY = "commands.message.display.outgoing";

/**
 * What the echo's `translate` holds on the client: the outgoing whisper format as the client registry renders it, or the
 * key itself when its language table lacks the key. The server sends the echo as a chat-type line, and Mineflayer files
 * such a line under the chat type's `formatString` (`mineflayer/lib/plugins/chat.js:112-121`, `fromNetwork`), which
 * prismarine-registry fills with the language's text for the key, not the key (`prismarine-registry/lib/pc/index.js:20`:
 * `language[translation_key] || translation_key`; contract check `whisper-echo`, run L of the in-game bot commands).
 * The game's own data gives the text: no wording here. The key is always accepted as well: it is what the line carries
 * when the table lacks it (a client registry in a language without the key).
 */
function outgoingWhisperFormats(bot: Bot): ReadonlySet<string> {
  const rendered: string | undefined = bot.registry.language[OUTGOING_WHISPER_KEY];
  return new Set(rendered === undefined ? [OUTGOING_WHISPER_KEY] : [rendered, OUTGOING_WHISPER_KEY]);
}

type MessageDelivery =
  | { readonly kind: "observed" }
  | { readonly kind: "not_observed" }
  | { readonly kind: "send_failed"; readonly cause: unknown };

type ChatListener = BotEvents["chat"];
type MessageListener = BotEvents["message"];

/** Send one message after arming observation so a synchronous echo cannot be missed. */
export async function sendMessage(
  bot: Bot,
  request: SendMessageRequest,
  context: ActionContext,
): Promise<SendMessageResult> {
  context.signal?.throwIfAborted();
  if (request.to !== undefined) return whisper(bot, request.message, request.to, context);
  return resultOf(await observePublicMessage(bot, request.message, context), request.message);
}

function resultOf(delivery: MessageDelivery, message: string, to?: string): SendMessageResult {
  const recipient = to === undefined ? {} : { to };
  switch (delivery.kind) {
    case "observed":
      return { status: "succeeded", message, ...recipient };
    case "not_observed":
      return {
        status: "failed",
        error: sendMessageOutcomes.notObserved(MESSAGE_ECHO_TIMEOUT_MS / 1_000),
        message,
        ...recipient,
      };
    case "send_failed":
      return { status: "failed", error: sendMessageOutcomes.sendFailed(delivery.cause), message, ...recipient };
  }
}

/** A whisper to a player online, spelled as the server knows them, confirmed by the server's own echo of it. */
async function whisper(bot: Bot, message: string, to: string, context: ActionContext): Promise<SendMessageResult> {
  const self = bot.username.toLowerCase();
  const target = Object.keys(bot.players).find((name) => name.toLowerCase() === to.toLowerCase() && name.toLowerCase() !== self);
  if (target === undefined) return { status: "failed", error: sendMessageOutcomes.playerNotOnline(to), message, to };
  const echoFormats = outgoingWhisperFormats(bot);
  const delivery = await observeDelivery(
    context,
    (finish) => {
      const onMessage: MessageListener = (jsonMsg) => {
        // The echo carries its text as the last argument of the translation; another whisper has another text.
        const { translate, with: args } = jsonMsg as unknown as { translate?: string; with?: readonly { toString(): string }[] };
        if (translate !== undefined && echoFormats.has(translate) && args?.at(-1)?.toString() === message) finish({ kind: "observed" });
      };
      bot.on("message", onMessage);
      return () => bot.off("message", onMessage);
    },
    () => bot.whisper(target, message),
  );
  return resultOf(delivery, message, target);
}

function observePublicMessage(bot: Bot, message: string, context: ActionContext): Promise<MessageDelivery> {
  return observeDelivery(
    context,
    (finish) => {
      const onChat: ChatListener = (username, observedMessage) => {
        if (username.toLowerCase() === bot.username.toLowerCase() && observedMessage === message) {
          finish({ kind: "observed" });
        }
      };
      bot.on("chat", onChat);
      return () => bot.off("chat", onChat);
    },
    () => bot.chat(message),
  );
}

/**
 * Arms `observe` (returns its own cleanup), then `send`s, and waits for `finish({ kind: "observed" })`, a send failure,
 * the timeout or the caller's cancellation, whichever comes first.
 */
function observeDelivery(
  context: ActionContext,
  observe: (finish: (delivery: MessageDelivery) => void) => () => void,
  send: () => void,
): Promise<MessageDelivery> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    let stopObserving = () => {};

    const cleanup = () => {
      stopObserving();
      context.signal?.removeEventListener("abort", onAbort);
      if (timer) clearTimeout(timer);
    };
    const finish = (delivery: MessageDelivery) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(delivery);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(context.signal?.reason ?? new Error("Message action cancelled."));
    };

    stopObserving = observe(finish);
    context.signal?.addEventListener("abort", onAbort, { once: true });
    if (context.signal?.aborted) {
      onAbort();
      return;
    }

    // Mineflayer chat() has no acknowledgement. Without this observation
    // window, a muted or suppressing server could leave the call pending forever.
    timer = setTimeout(() => finish({ kind: "not_observed" }), MESSAGE_ECHO_TIMEOUT_MS);
    try {
      send();
    } catch (cause) {
      finish({ kind: "send_failed", cause });
    }
  });
}

export function formatSendMessageResult(result: SendMessageResult): string {
  const channel = result.to === undefined ? "Public chat" : `Whisper to ${result.to}`;
  const observation = result.status === "succeeded" ? `${channel}: echo observed.` : `**Observed stop:** ${result.error}`;
  return `${observation}\n\n${markdownCodeBlock(result.message)}`;
}

export function createSendMessageAction(bot: Bot) {
  return defineAction({
    name: SEND_MESSAGE,
    description: SEND_MESSAGE_DESCRIPTION,
    inputSchema: sendMessageInputSchema,
    resultSchema: sendMessageResultSchema,
    formatResult: formatSendMessageResult,
    execution: { kind: "concurrent" },
    annotations: sendMessageAnnotations,
    parse: parseSendMessageRequest,
    execute: (request, context) => sendMessage(bot, request, context),
  });
}
