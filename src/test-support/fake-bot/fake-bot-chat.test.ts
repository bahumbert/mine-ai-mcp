import assert from "node:assert/strict";
import test from "node:test";
import { createFakeBot } from "./fake-bot.js";

/** What a `message` event carried: the rendered text, the translate Mineflayer filed, its arguments and the position. */
interface Heard {
  readonly text: string;
  readonly translate: string | undefined;
  readonly args: readonly string[];
  readonly position: string;
}

function hearMessages(harness: ReturnType<typeof createFakeBot>): Heard[] {
  const heard: Heard[] = [];
  harness.bot.on("message", (message, position) => {
    const line = message as unknown as { translate?: string; with?: { toString(): string }[] };
    heard.push({ text: message.toString(), translate: line.translate, args: (line.with ?? []).map(String), position });
  });
  return heard;
}

test("a whisper to a player online is echoed to the whisperer one server tick later as the game sends it: a chat line of the outgoing format with the name and the text", async () => {
  const harness = createFakeBot({ players: { Hearer: {} } });
  const heard = hearMessages(harness);
  const lines: string[] = [];
  harness.bot.on("messagestr", (text) => void lines.push(text));
  harness.bot.whisper("Hearer", "hello there");
  assert.equal(heard.length, 0, "the echo comes from the server, not inside the call");
  await harness.clock.advance(50);
  assert.equal(heard.length, 1);
  assert.deepEqual(lines, ["You whisper to Hearer: hello there"], "also filed as messagestr, as Mineflayer files every chat line");
  // `contract whisper-echo`: translate is the English format string the registry holds for the key, not the key.
  assert.equal(heard[0]!.translate, harness.bot.registry.language["commands.message.display.outgoing"]);
  assert.equal(heard[0]!.text, "You whisper to Hearer: hello there");
  assert.deepEqual(heard[0]!.args, ["Hearer", "hello there"]);
  assert.equal(heard[0]!.position, "chat");
});

test("two whispers sent back to back are echoed in the order sent", async () => {
  const harness = createFakeBot({ players: { Hearer: {} } });
  const heard = hearMessages(harness);
  harness.bot.whisper("Hearer", "echo probe 1");
  harness.bot.whisper("Hearer", "echo probe 2");
  await harness.clock.advance(100);
  assert.deepEqual(heard.map(({ args }) => args.at(-1)), ["echo probe 1", "echo probe 2"]);
});

test("a whisper to nobody online is echoed by nothing (the game's error line is unmeasured and absent)", async () => {
  const harness = createFakeBot({ players: { Hearer: {} } });
  const heard = hearMessages(harness);
  harness.bot.whisper("Nobody", "hello");
  await harness.clock.advance(500);
  assert.equal(heard.length, 0);
});

test("a server that sends no echo (muted) leaves the whisperer hearing nothing", async () => {
  const harness = createFakeBot({ players: { Hearer: {} }, chat: { echoWhispers: false } });
  const heard = hearMessages(harness);
  harness.bot.whisper("Hearer", "hello there");
  await harness.clock.advance(500);
  assert.equal(heard.length, 0);
});
