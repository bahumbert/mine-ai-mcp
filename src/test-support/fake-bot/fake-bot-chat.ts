/**
 * The fake bot's whispers, as the server answers them (contract check `whisper-echo`, measured on a 1.21.4 server): the
 * whisperer hears the outgoing format ("You whisper to <name>: <text>") as a `message` event at position `chat`, one
 * server tick after the command; a whisper to oneself is then also heard as received ("<name> whispers to you: <text>").
 * Mineflayer builds the line from the chat type the server sent (`chat.js:112-121`): prismarine-chat `fromNetwork`, whose
 * `translate` is the registry's English format string (`prismarine-registry/lib/pc/index.js:20`), not the translation key.
 * The contract check whispers to the bot itself (a contract scenario has one player), so the outgoing line for another
 * player is inferred from it, not measured. Unmeasured and left out: the error line for a name nobody has (the fake says
 * nothing), a name spelled in another case than the player list's (the fake says nothing; `send_message` passes the
 * server's spelling), the incoming line for a target other than the bot (the game sends it to the target), and the
 * `whisper` event, which Mineflayer's default chat pattern raises from the received line (`chat.js:74-80,222`; the fake
 * loads no chat plugin). No packet is written: `server.packets` stays empty.
 */
import { createRequire } from "node:module";
import type { Bot } from "mineflayer";
import type { FakeBot } from "./fake-bot.js";
import type { FakeServer } from "./fake-server.js";

const require = createRequire(import.meta.url);

/** `chat.js` position 0: a chat line (the `ChatMessage` positions Mineflayer names). */
const CHAT_POSITION = "chat";
/** The chat types the game files the outgoing and the received whisper under (`chatFormattingByName`). */
const OUTGOING_WHISPER_TYPE = "minecraft:msg_command_outgoing";
const INCOMING_WHISPER_TYPE = "minecraft:msg_command_incoming";

interface ChatFormat {
  readonly id: number;
}

interface ChatMessages {
  fromNetwork(chatType: number, parameters: Readonly<Record<string, unknown>>): { toString(): string };
}

export interface FakeChatOptions {
  /** False: a server that sends no echo of a whisper (muted, or lost); true when omitted. */
  readonly echoWhispers?: boolean;
}

/** Give `bot` `whisper`: the command goes to the server, which answers one tick later. */
export function attachFakeChat(bot: FakeBot, parts: { server: FakeServer; options?: FakeChatOptions }): void {
  const messages = (require("prismarine-chat") as (registry: Bot["registry"]) => ChatMessages)(bot.registry);
  const formats = bot.registry as unknown as { chatFormattingByName: Readonly<Record<string, ChatFormat>> };
  const hear = (chatType: string, parameters: Readonly<Record<string, unknown>>) => {
    const format = formats.chatFormattingByName[chatType];
    if (format === undefined) throw new Error(`the fake registry has no chat type ${chatType}`);
    // The id as the registry holds it: no +1 here, minecraft-protocol's holder decoder already took one off (`compiler-minecraft.js:49`).
    const line = messages.fromNetwork(format.id, parameters);
    bot.emit("message", line as never, CHAT_POSITION);
    bot.emit("messagestr", line.toString(), CHAT_POSITION, line as never);
  };
  bot.whisper = (username, message) => {
    const target = Object.keys(bot.players).find((name) => name === username);
    if (target === undefined || parts.options?.echoWhispers === false) return;
    parts.server.answer(() => {
      hear(OUTGOING_WHISPER_TYPE, { target: { text: target }, content: { text: message } });
      if (target === bot.username) hear(INCOMING_WHISPER_TYPE, { sender: { text: bot.username }, content: { text: message } });
    });
  };
}
