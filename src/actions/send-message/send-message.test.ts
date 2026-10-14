import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import test from "node:test";
import { ActionRunner } from "../../session/action-runner.js";
import { botFixture } from "../../test-support/bot.js";
import {
  createSendMessageAction,
  formatSendMessageResult,
  parseSendMessageRequest,
} from "./index.js";

function chatBot(send: (bot: Bot, message: string) => void): Bot {
  const bot = botFixture({ username: "MineAI" });
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

/** What the server tells a whisperer: `commands.message.display.outgoing` with the target and the text. */
function whisperEcho(target: string, text: string) {
  return { translate: "commands.message.display.outgoing", with: [{ toString: () => target }, { toString: () => text }] };
}

/** The server's line reaching the client: Mineflayer's `message` event, whose payload is all the action reads. */
function emitMessage(bot: Bot, line: ReturnType<typeof whisperEcho>) {
  (bot as unknown as { emit(event: string, ...args: unknown[]): boolean }).emit("message", line);
}

function whisperBot(players: string[], echo: (bot: Bot, to: string, message: string) => void = (bot, to, message) => emitMessage(bot, whisperEcho(to, message))) {
  const bot = botFixture({ username: "MineAI", players: Object.fromEntries(players.map((name) => [name, { username: name }])) });
  const whispered: [string, string][] = [];
  const publicLines: string[] = [];
  bot.chat = (message) => publicLines.push(message);
  bot.whisper = (to, message) => {
    whispered.push([to, message]);
    echo(bot, to, message);
  };
  return { bot, whispered, publicLines };
}

test("accepts a whisper target that is a username, and keeps the whisper short enough for one command", () => {
  assert.deepEqual(parseSendMessageRequest({ message: "psst", to: "Alex_2" }), { message: "psst", to: "Alex_2" });
  for (const to of ["", "Al ex", "x".repeat(17), "/op", "Al,ex", "Alex\n"]) {
    assert.throws(() => parseSendMessageRequest({ message: "psst", to }), Error, JSON.stringify(to));
  }
  assert.throws(() => parseSendMessageRequest({ message: "x".repeat(240), to: "Alex" }));
  assert.doesNotThrow(() => parseSendMessageRequest({ message: "x".repeat(240) }));
});

test("a whisper goes to the named player online, not to public chat, and succeeds on the server's own echo", async () => {
  const { bot, whispered, publicLines } = whisperBot(["Alex", "Bob"]);
  const output = await new ActionRunner().run(createSendMessageAction(bot), { message: "On my way", to: "alex" });
  assert.deepEqual(whispered, [["Alex", "On my way"]]);
  assert.deepEqual(publicLines, []);
  assert.deepEqual(output.result, { status: "succeeded", message: "On my way", to: "Alex" });
  assert.equal(bot.listenerCount("message"), 0);
  assert.match(formatSendMessageResult({ status: "succeeded", message: "On my way", to: "Alex" }), /Whisper to Alex: echo observed/);
});

test("a whisper to nobody online (or to the bot itself) is refused before anything is sent", async () => {
  const { bot, whispered } = whisperBot(["Alex"]);
  for (const to of ["Zed", "MineAI"]) {
    const output = await new ActionRunner().run(createSendMessageAction(bot), { message: "hello", to });
    assert.equal(output.result.status, "failed");
    assert.match("error" in output.result ? output.result.error : "", /^\[PLAYER_NOT_ONLINE\]/);
    assert.equal("to" in output.result ? output.result.to : null, to);
  }
  assert.deepEqual(whispered, []);
});

test("a whisper is confirmed only by the echo of its own text; a refusal from mineflayer is reported", async () => {
  const noisy = whisperBot(["Alex"], (bot, to, message) => {
    emitMessage(bot, whisperEcho(to, "something else"));
    emitMessage(bot, whisperEcho(to, message));
  });
  assert.equal((await new ActionRunner().run(createSendMessageAction(noisy.bot), { message: "hello", to: "Alex" })).result.status, "succeeded");

  const failing = whisperBot(["Alex"], () => {
    throw new Error("chat disabled");
  });
  const output = await new ActionRunner().run(createSendMessageAction(failing.bot), { message: "hello", to: "Alex" });
  assert.match("error" in output.result ? output.result.error : "", /MESSAGE_SEND_FAILED.*chat disabled/);
  assert.equal(failing.bot.listenerCount("message"), 0);
});

test("a cancelled whisper releases its echo listener", async () => {
  const { bot } = whisperBot(["Alex"], () => {});
  const controller = new AbortController();
  const pending = new ActionRunner().run(createSendMessageAction(bot), { message: "hello", to: "Alex" }, controller.signal);
  controller.abort(new Error("stop waiting"));
  assert.equal((await pending).result.status, "cancelled");
  assert.equal(bot.listenerCount("message"), 0);
});
