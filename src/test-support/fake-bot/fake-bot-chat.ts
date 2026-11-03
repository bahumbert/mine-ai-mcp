/**
 * Mineflayer's chat plugin on the fake (`mineflayer/lib/plugins/chat.js`, 4.39.0): chat patterns, its default `chat`
 * and `whisper` patterns, and the two packets a line reaches the client by (a player's chat, a system line).
 *
 * The fake bot's whispers, as the server answers them (contract check `whisper-echo`, measured on a 1.21.4 server): the
 * whisperer hears the outgoing format ("You whisper to <name>: <text>") as a `message` event at position `chat`, one
 * server tick after the command; a whisper to oneself is then also heard as received ("<name> whispers to you: <text>").
 * Mineflayer builds the line from the chat type the server sent (`chat.js:112-121`): prismarine-chat `fromNetwork`, whose
 * `translate` is the registry's English format string (`prismarine-registry/lib/pc/index.js:20`), not the translation key.
 * The contract check whispers to the bot itself (a contract scenario has one player), so the outgoing line for another
 * player is inferred from it, not measured. Unmeasured and left out: the error line for a name nobody has (the fake says
 * nothing), a name spelled in another case than the player list's (the fake says nothing; `send_message` passes the
 * server's spelling) and the incoming line for a target other than the bot (the game sends it to the target). The
 * received line raises the `whisper` event through the default chat pattern above (`chat.js:74-80,222`). No packet is
 * written: `server.packets` stays empty.
 */
import { createRequire } from "node:module";
import type { Bot } from "mineflayer";
import type { FakeBot } from "./fake-bot.js";
import type { FakeServer } from "./fake-server.js";

const require = createRequire(import.meta.url);

interface ChatLine {
  readonly translate?: string;
  toString(): string;
}
interface ChatMessages {
  fromNotch(json: string): ChatLine;
  fromNetwork(chatType: number, parameters: Readonly<Record<string, unknown>>): ChatLine;
}
const chatMessagesOf = require("prismarine-chat") as (registry: Bot["registry"]) => ChatMessages;

/** `chat.js` position 0: a chat line (the `ChatMessage` positions Mineflayer names). */
const CHAT_POSITION = "chat";
/** The chat types the game files the outgoing and the received whisper under (`chatFormattingByName`). */
const OUTGOING_WHISPER_TYPE = "minecraft:msg_command_outgoing";
const INCOMING_WHISPER_TYPE = "minecraft:msg_command_incoming";

interface ChatFormat {
  readonly id: number;
}

/** `chat.js:3-4`. */
const USERNAME_REGEX = "(?:\\(.{1,15}\\)|\\[.{1,15}\\]|.){0,5}?(\\w+)";
const LEGACY_VANILLA_CHAT_REGEX = new RegExp(`^${USERNAME_REGEX}\\s?[>:\\-»\\]\\)~]+\\s(.*)$`);

interface ChatPattern {
  readonly name: string;
  readonly patterns: readonly RegExp[];
  position: number;
  matches: string[];
  messages: ChatLine[];
  readonly deprecated: boolean;
  readonly repeat: boolean;
  readonly parse: boolean;
}

/** Mineflayer's options, with the `deprecated` flag its default patterns use and its typings leave out. */
interface PatternOptions {
  readonly repeat?: boolean;
  readonly parse?: boolean;
  readonly deprecated?: boolean;
}

export interface FakeChat {
  /**
   * A system line (`systemChat`, position 1), plain text or a chat component: Localized Chat sends talk heard from afar
   * so (spike 2026-10-17, result 4), a server its unknown-command reply.
   */
  hearSystem(line: string | object): void;
  /** A player's vanilla chat line, `<username> text` (`playerChat`, chat type `chat.type.text`). */
  hearPlayer(username: string, text: string): void;
}

export interface FakeChatOptions {
  /** False: a server that sends no echo of a whisper (muted, or lost); true when omitted. */
  readonly echoWhispers?: boolean;
}

/**
 * `addChatPattern`, `removeChatPattern` and the `messagestr` listener of `chat.js:34-108`, with its default patterns
 * (218-225); and `whisper`: the command goes to the server, which answers one tick later.
 */
export function attachFakeChat(bot: FakeBot, parts: { server: FakeServer; options?: FakeChatOptions }): FakeChat {
  const ChatMessage = chatMessagesOf(bot.registry);
  const formats = bot.registry as unknown as { chatFormattingByName: Readonly<Record<string, ChatFormat>> };
  // Pattern events are named at run time (`chat:<name>`, or the pattern's own name): Bot's typed `emit` lists none of them.
  const emit = bot.emit.bind(bot) as (event: string, ...args: unknown[]) => boolean;
  const patterns: (ChatPattern | undefined)[] = [];
  const addPattern = (name: string, pattern: RegExp, options: PatternOptions = {}): number => {
    const { repeat = true, parse = false, deprecated = false } = options;
    patterns.push({ name, patterns: [pattern], position: 0, matches: [], messages: [], deprecated, repeat, parse });
    return patterns.length - 1;
  };
  bot.addChatPattern = addPattern;
  bot.removeChatPattern = (name) => {
    patterns.forEach((pattern, index) => {
      if (typeof name === "number" ? index === name : pattern?.name === name) patterns[index] = undefined;
    });
  };
  bot.on("messagestr", (text: string, _position: string, line: ChatLine) => {
    const found = patterns.flatMap((pattern, index) => (pattern?.patterns[pattern.position]?.test(text) ? [index] : []));
    for (const index of found) {
      const pattern = patterns[index]!;
      pattern.matches.push(text);
      pattern.messages.push(line);
      pattern.position++;
      if (pattern.deprecated) {
        const [, ...groups] = pattern.matches[0]!.match(pattern.patterns[0]!)!;
        emit(pattern.name, ...groups, pattern.messages[0]!.translate, ...pattern.messages);
        pattern.messages = [];
      } else {
        // `chat.js:88`: a set not yet complete returns from the whole listener.
        if (pattern.patterns.length > pattern.matches.length) return;
        emit(`chat:${pattern.name}`, pattern.parse ? pattern.patterns.map((regex, i) => pattern.matches[i]!.match(regex)!.slice(1)) : pattern.matches);
      }
      if (patterns[index]?.repeat) {
        pattern.position = 0;
        pattern.matches = [];
      } else {
        patterns[index] = undefined;
      }
    }
  });
  addPattern("whisper", new RegExp(`^${USERNAME_REGEX} whispers(?: to you)?:? (.*)$`), { deprecated: true });
  addPattern("whisper", new RegExp(`^\\[${USERNAME_REGEX} -> \\w+\\s?\\] (.*)$`), { deprecated: true });
  addPattern("chat", LEGACY_VANILLA_CHAT_REGEX, { deprecated: true });

  const hearLine = (line: ChatLine, position: "chat" | "system") => {
    emit("message", line, position, null);
    emit("messagestr", line.toString(), position, line, null);
  };
  const hear = (json: unknown, position: "chat" | "system") => hearLine(ChatMessage.fromNotch(JSON.stringify(json)), position);
  const hearWhisper = (chatType: string, parameters: Readonly<Record<string, unknown>>) => {
    const format = formats.chatFormattingByName[chatType];
    if (format === undefined) throw new Error(`the fake registry has no chat type ${chatType}`);
    // The id as the registry holds it: no +1 here, minecraft-protocol's holder decoder already took one off (`compiler-minecraft.js:49`).
    hearLine(ChatMessage.fromNetwork(format.id, parameters), CHAT_POSITION);
  };
  bot.whisper = (username, message) => {
    const target = Object.keys(bot.players).find((name) => name === username);
    if (target === undefined || parts.options?.echoWhispers === false) return;
    parts.server.answer(() => {
      hearWhisper(OUTGOING_WHISPER_TYPE, { target: { text: target }, content: { text: message } });
      if (target === bot.username) hearWhisper(INCOMING_WHISPER_TYPE, { sender: { text: bot.username }, content: { text: message } });
    });
  };
  return {
    hearSystem: (line) => hear(typeof line === "string" ? { text: line } : line, "system"),
    hearPlayer: (username, text) => hear({ translate: "chat.type.text", with: [{ text: username }, { text }] }, "chat"),
  };
}
