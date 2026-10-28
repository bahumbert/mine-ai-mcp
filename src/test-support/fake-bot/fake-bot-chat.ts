/**
 * Mineflayer's chat plugin on the fake (`mineflayer/lib/plugins/chat.js`, 4.39.0): chat patterns, its default `chat`
 * and `whisper` patterns, and the two packets a line reaches the client by (a player's chat, a system line).
 */
import { createRequire } from "node:module";
import type { Bot } from "mineflayer";
import type { FakeBot } from "./fake-bot.js";

const require = createRequire(import.meta.url);

interface ChatLine {
  readonly translate?: string;
  toString(): string;
}
const chatMessagesOf = require("prismarine-chat") as (registry: Bot["registry"]) => { fromNotch(json: string): ChatLine };

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

/** `addChatPattern`, `removeChatPattern` and the `messagestr` listener of `chat.js:34-108`, with its default patterns (218-225). */
export function attachFakeChat(bot: FakeBot): FakeChat {
  const ChatMessage = chatMessagesOf(bot.registry);
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

  const hear = (json: unknown, position: "chat" | "system") => {
    const line = ChatMessage.fromNotch(JSON.stringify(json));
    emit("message", line, position, null);
    emit("messagestr", line.toString(), position, line, null);
  };
  return {
    hearSystem: (line) => hear(typeof line === "string" ? { text: line } : line, "system"),
    hearPlayer: (username, text) => hear({ translate: "chat.type.text", with: [{ text: username }, { text }] }, "chat"),
  };
}
