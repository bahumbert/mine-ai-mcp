import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import test from "node:test";
import { ActionRunner } from "../../session/action-runner.js";
import { type FakeBotOptions, createFakeBot, createFakeClock } from "../../test-support/fake-bot/index.js";
import {
  createSendMessageAction,
  isChatTextAccepted,
  formatSendMessageResult,
  parseSendMessageRequest,
} from "./index.js";

function chatBot(send: (bot: Bot, message: string) => void): Bot {
  const { bot } = createFakeBot({ username: "MineAI" });
  bot.chat = (message) => send(bot, message);
  return bot;
}

test("accepts one public chat line and rejects commands or Mineflayer-split messages", () => {
  assert.deepEqual(parseSendMessageRequest({ message: "  Hello Alex!  " }), { message: "Hello Alex!" });
  for (const message of ["", "   ", "/say hidden command", "first\nsecond", "x".repeat(257)]) {
    assert.throws(() => parseSendMessageRequest({ message }));
  }
  assert.throws(() => parseSendMessageRequest({ message: "hello", recipient: "Alex" }));
});

test("succeeds only after observing the bot's exact public chat echo", async () => {
  const sent: string[] = [];
  const bot = chatBot((chatBot, message) => {
    sent.push(message);
    chatBot.emit("chat", "SomeoneElse", message, null, {} as never, null);
    chatBot.emit("chat", chatBot.username, `${message}!`, null, {} as never, null);
    chatBot.emit("chat", chatBot.username, message, null, {} as never, null);
  });

  const action = createSendMessageAction(bot);
  const output = await new ActionRunner().run(action, { message: "Hello Alex" });

  assert.deepEqual(sent, ["Hello Alex"]);
  assert.deepEqual(output.result, { status: "succeeded", message: "Hello Alex" });
  assert.equal(bot.listenerCount("chat"), 0);
  assert.equal(action.annotations?.readOnlyHint, false);
  assert.equal(action.annotations?.idempotentHint, false);
  assert.match(formatSendMessageResult({ status: "succeeded", message: "Hello Alex" }), /echo observed/);
});

test("reports a Mineflayer send refusal with action-owned evidence", async () => {
  const bot = chatBot(() => {
    throw new Error("chat disabled");
  });

  const output = await new ActionRunner().run(createSendMessageAction(bot), { message: "Hello" });

  assert.equal(output.result.status, "failed");
  assert.match("error" in output.result ? output.result.error : "", /MESSAGE_SEND_FAILED.*chat disabled/);
  assert.equal("message" in output.result ? output.result.message : null, "Hello");
  assert.equal(bot.listenerCount("chat"), 0);
});

test("releases its echo listener when the caller cancels", async () => {
  const bot = chatBot(() => {});
  const controller = new AbortController();
  const pending = new ActionRunner().run(
    createSendMessageAction(bot),
    { message: "Hello" },
    controller.signal,
  );
  controller.abort(new Error("stop waiting for chat"));

  const output = await pending;
  assert.equal(output.result.status, "cancelled");
  assert.equal(bot.listenerCount("chat"), 0);
});

/**
 * A bot whose whispers the shared fake answers as the 1.21.4 server does (`fake-bot-chat.ts`, contract check
 * `whisper-echo`): an echo one server tick later. The wait for it is a wall-clock timer, so the caller installs `clock`.
 * `onWhisper` replaces what happens when the bot whispers, given the fake's own `send` (a refusal, another text's echo).
 */
function whisperBot(
  players: string[],
  options: {
    chat?: FakeBotOptions["chat"];
    onWhisper?: (send: (to: string, message: string) => void, to: string, message: string) => void;
  } = {},
) {
  const clock = createFakeClock({ mode: "mocked" });
  const { bot } = createFakeBot({
    username: "MineAI",
    clock,
    chat: options.chat,
    players: Object.fromEntries(players.map((name) => [name, { username: name }])),
  });
  const whispered: [string, string][] = [];
  const publicLines: string[] = [];
  bot.chat = (message) => {
    publicLines.push(message);
  };
  const sendWhisper = bot.whisper.bind(bot);
  bot.whisper = (to, message) => {
    whispered.push([to, message]);
    (options.onWhisper ?? ((send, target, text) => send(target, text)))(sendWhisper, to, message);
  };
  return { bot, clock, whispered, publicLines };
}

test("accepts a whisper target that is a username, and keeps the whisper short enough for one command", () => {
  assert.deepEqual(parseSendMessageRequest({ message: "psst", to: "Alex_2" }), { message: "psst", to: "Alex_2" });
  for (const to of ["", "Al ex", "x".repeat(17), "/op", "Al,ex", "Alex\n"]) {
    assert.throws(() => parseSendMessageRequest({ message: "psst", to }), Error, JSON.stringify(to));
  }
  assert.throws(() => parseSendMessageRequest({ message: "x".repeat(240), to: "Alex" }));
  assert.doesNotThrow(() => parseSendMessageRequest({ message: "x".repeat(240) }));
});

test("two whispers sent back to back are both confirmed", async () => {
  const { bot, clock, whispered } = whisperBot(["Alex"]);
  using _installed = clock.install();
  const action = createSendMessageAction(bot);
  const runner = new ActionRunner();
  const both = Promise.all([runner.run(action, { message: "line 1", to: "Alex" }), runner.run(action, { message: "line 2", to: "Alex" })]);
  const outputs = await clock.settle(both, 1_000);
  assert.deepEqual(outputs.map(({ result }) => result.status), ["succeeded", "succeeded"]);
  assert.deepEqual(whispered, [["Alex", "line 1"], ["Alex", "line 2"]]);
  assert.equal(bot.listenerCount("message"), 0);
});

// Red before the fix: the fake echoes as `contract whisper-echo` measured (`translate` = the registry's English format, not the key).
test("a whisper is confirmed by the echo as 1.21.4 sends it: it goes to the named player online, not to public chat", async () => {
  const { bot, clock, whispered, publicLines } = whisperBot(["Alex", "Bob"]);
  using _installed = clock.install();
  const output = await clock.settle(new ActionRunner().run(createSendMessageAction(bot), { message: "On my way", to: "alex" }), 1_000);
  assert.deepEqual(whispered, [["Alex", "On my way"]]);
  assert.deepEqual(publicLines, []);
  assert.deepEqual(output.result, { status: "succeeded", message: "On my way", to: "Alex" });
  assert.equal(bot.listenerCount("message"), 0);
  assert.match(formatSendMessageResult({ status: "succeeded", message: "On my way", to: "Alex" }), /Whisper to Alex: echo observed/);
});

test("a whisper to nobody online (or to the bot itself) is refused before anything is sent", async () => {
  const { bot, whispered } = whisperBot(["Alex"]);
  for (const to of ["Zed", "MineAI"]) {
    // Refused before any wait, so no timer is armed and the manual wait needs no installed clock.
    const output = await new ActionRunner().run(createSendMessageAction(bot), { message: "hello", to });
    assert.equal(output.result.status, "failed");
    assert.match("error" in output.result ? output.result.error : "", /^\[PLAYER_NOT_ONLINE\]/);
    assert.equal("to" in output.result ? output.result.to : null, to);
  }
  assert.deepEqual(whispered, []);
});

test("a whisper is confirmed only by the echo of its own text; a refusal from mineflayer is reported", async () => {
  {
    // Another text's echo arrives and confirms nothing: the same whisper to a muted-for-this-text server times out.
    const other = whisperBot(["Alex"], { onWhisper: (send, to) => send(to, "something else") });
    using _installed = other.clock.install();
    const output = await other.clock.settle(new ActionRunner().run(createSendMessageAction(other.bot), { message: "hello", to: "Alex" }), 6_000);
    assert.match("error" in output.result ? output.result.error : "", /^\[MESSAGE_NOT_OBSERVED\]/);
  }
  const failing = whisperBot(["Alex"], {
    onWhisper: () => {
      throw new Error("chat disabled");
    },
  });
  using _installed = failing.clock.install();
  const output = await failing.clock.settle(new ActionRunner().run(createSendMessageAction(failing.bot), { message: "hello", to: "Alex" }), 1_000);
  assert.match("error" in output.result ? output.result.error : "", /MESSAGE_SEND_FAILED.*chat disabled/);
  assert.equal(failing.bot.listenerCount("message"), 0);
});

test("a whisper the server never echoes (muted) fails as not observed after 5 s", async () => {
  const { bot, clock } = whisperBot(["Alex"], { chat: { echoWhispers: false } });
  using _installed = clock.install();
  const pending = new ActionRunner().run(createSendMessageAction(bot), { message: "hello", to: "Alex" });
  let settled = false;
  void pending.then(() => (settled = true));
  await clock.advance(4_900);
  assert.equal(settled, false, "still waiting before the 5 s bound");
  const output = await clock.settle(pending, 200);
  assert.match("error" in output.result ? output.result.error : "", /^\[MESSAGE_NOT_OBSERVED\]/);
  assert.equal(bot.listenerCount("message"), 0);
});

test("a cancelled whisper releases its echo listener", async () => {
  const { bot, clock } = whisperBot(["Alex"], { chat: { echoWhispers: false } });
  using _installed = clock.install();
  const controller = new AbortController();
  const pending = new ActionRunner().run(createSendMessageAction(bot), { message: "hello", to: "Alex" }, controller.signal);
  await clock.advance(1_000);
  controller.abort(new Error("stop waiting"));
  assert.equal((await pending).result.status, "cancelled");
  assert.equal(bot.listenerCount("message"), 0);
});

test("refuses § and control characters before anything is sent, in public chat and in a whisper", async () => {
  for (const message of ["a§b", "bell\u0007", "del\u007f", "tab\there", "\u0007hi", "hi\u0000", "§"]) {
    assert.throws(() => parseSendMessageRequest({ message }), /Message holds characters the server refuses/, JSON.stringify(message));
    assert.throws(() => parseSendMessageRequest({ message, to: "Alex" }), /Message holds characters the server refuses/, JSON.stringify(message));
  }
  const { bot, whispered, publicLines } = whisperBot(["Alex"]);
  const action = createSendMessageAction(bot);
  for (const input of [{ message: "a§b" }, { message: "a§b", to: "Alex" }]) {
    const { result } = await new ActionRunner().run(action, input);
    assert.equal(result.status, "failed");
    assert.match("error" in result ? result.error : "", /^\[INVALID_ARGUMENTS\].*remove them and send again/s);
  }
  assert.deepEqual([publicLines, whispered], [[], []]);
});

test("the refusal for § and control characters tells the model to remove them and send again", () => {
  assert.throws(() => parseSendMessageRequest({ message: "a§b" }), /remove them and send again/);
});

test("accepts accented letters and emoji", () => {
  assert.deepEqual(parseSendMessageRequest({ message: "été 🙂" }), { message: "été 🙂" });
  assert.deepEqual(parseSendMessageRequest({ message: "café", to: "Alex" }), { message: "café", to: "Alex" });
});

test("isChatTextAccepted refuses the characters the server disconnects a client for, not the length", () => {
  assert.equal(isChatTextAccepted("plain text"), true);
  assert.equal(isChatTextAccepted("a§b"), false);
  assert.equal(isChatTextAccepted("a\u001fb"), false);
  assert.equal(isChatTextAccepted("a\u007fb"), false);
  assert.equal(isChatTextAccepted("x".repeat(256)), true);
  assert.throws(() => parseSendMessageRequest({ message: `${"x".repeat(255)}§` }), /server refuses/);
  assert.throws(() => parseSendMessageRequest({ message: `${"x".repeat(256)}§` }));
});
