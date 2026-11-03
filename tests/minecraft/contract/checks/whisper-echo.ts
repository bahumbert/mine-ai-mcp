/**
 * The server's answer to a whisper: for each `/tell` the whisperer is sent a chat line of the outgoing format
 * ("You whisper to <name>: <text>"); a whisper to oneself is then also heard as received ("<name> whispers to you:
 * <text>"). Mineflayer files each as a `message` at position `chat` whose `translate` is the registry's English format string,
 * not the translation key (`prismarine-registry/lib/pc/index.js:20`), with the name and the text as its two arguments.
 * Measured 2026-10-31 on the shared server (one run): both whispers, sent back to back, answered in order, the four lines within 1 ms of each other.
 * The target is the bot itself: a contract scenario has one player (`setup-commands.test.ts`), so there is no second client to whisper to.
 */
import assert from "node:assert/strict";
import type { ContractCheck } from "../checks.ts";
import { answerSettled } from "../server-answer.ts";

const OUTGOING_KEY = "commands.message.display.outgoing";
const INCOMING_KEY = "commands.message.display.incoming";
const WHISPERS = ["echo probe 1", "echo probe 2"] as const;

/** A `message` event as the check keeps it. */
interface Heard {
  readonly position: string;
  readonly translate: string | undefined;
  readonly args: readonly string[];
  readonly text: string;
}

export const whisperEcho: ContractCheck = {
  name: "whisper-echo",
  // Our runtime would not whisper, but it also reads chat; the bare bot hears exactly what the server sends.
  withoutRuntime: true,
  fixture: { cells: {}, carried: {}, position: [0.5, -60, 0.5] },
  async run(subject) {
    const { bot } = subject;
    const heard: Heard[] = [];
    const onMessage = (message: unknown, position: string): void => {
      const line = message as { translate?: string; with?: { toString(): string }[]; toString(): string };
      heard.push({ position, translate: line.translate, args: (line.with ?? []).map((part) => part.toString()), text: line.toString() });
    };
    bot.on("message", onMessage);
    try {
      for (const text of WHISPERS) bot.whisper(bot.username, text);
      await answerSettled(subject, () => heard.length >= WHISPERS.length * 2, "the echo of two whispers");
    } finally {
      bot.off("message", onMessage);
    }
    const outgoing = bot.registry.language[OUTGOING_KEY];
    const incoming = bot.registry.language[INCOMING_KEY];
    assert.ok(outgoing !== undefined && incoming !== undefined, "the registry holds the English text of both whisper formats");
    const expected = WHISPERS.flatMap((text) => [
      { position: "chat", translate: outgoing, args: [bot.username, text], text: outgoing.replace("%s", bot.username).replace("%s", text) },
      { position: "chat", translate: incoming, args: [bot.username, text], text: incoming.replace("%s", bot.username).replace("%s", text) },
    ]);
    assert.deepEqual(heard, expected, "each whisper is echoed as sent, then heard as received, in the order sent, and nothing else");
  },
};
