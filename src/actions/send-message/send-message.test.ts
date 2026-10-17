import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import test from "node:test";
import { ActionRunner } from "../../session/action-runner.js";
import { createFakeBot, type FakeChat } from "../../test-support/fake-bot/index.js";
import {
  createSendMessageAction,
  isChatTextAccepted,
  formatSendMessageResult,
  parseSendMessageRequest,
} from "./index.js";

/** `send` answers each line the bot sends; `chat` (also returned by `chatHarness`) delivers what the server says back. */
function chatBot(send: (bot: Bot, message: string, chat: FakeChat) => void): Bot {
  return chatHarness(send).bot;
}
function chatHarness(send: (bot: Bot, message: string, chat: FakeChat) => void) {
  const { bot, chat } = createFakeBot({ username: "MineAI" });
  bot.chat = (message) => send(bot, message, chat);
  return { bot, chat };
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
  bot.emit("message", line as never, "chat");
}

function whisperBot(players: string[], echo: (bot: Bot, to: string, message: string) => void = (bot, to, message) => emitMessage(bot, whisperEcho(to, message))) {
  const { bot } = createFakeBot({ username: "MineAI", players: Object.fromEntries(players.map((name) => [name, { username: name }])) });
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

test("a shout is sent as /shout and confirmed by the same chat echo as public talk", async () => {
  const sent: string[] = [];
  // Localized Chat's /shout comes back as vanilla chat, to the shouter too (spike 2026-10-17, result 5).
  const bot = chatBot((chatBot, message, chat) => {
    sent.push(message);
    chat.hearPlayer(chatBot.username, message.replace("/shout ", ""));
  });
  const output = await new ActionRunner().run(createSendMessageAction(bot), { message: "Anyone near the village?", shout: true });
  assert.deepEqual(sent, ["/shout Anyone near the village?"]);
  assert.deepEqual(output.result, { status: "succeeded", message: "Anyone near the village?" });
  assert.equal(bot.listenerCount("chat"), 0);
  assert.equal(bot.listenerCount("message"), 0);
});

test("a shout cannot be a whisper and must fit one /shout command", () => {
  assert.throws(() => parseSendMessageRequest({ message: "hi", shout: true, to: "Alex" }), /cannot be combined with `to`/);
  assert.throws(() => parseSendMessageRequest({ message: "x".repeat(250), shout: true }), /at most 249/);
  assert.deepEqual(parseSendMessageRequest({ message: "x".repeat(249), shout: true }), { message: "x".repeat(249), shout: true });
  assert.doesNotThrow(() => parseSendMessageRequest({ message: "x".repeat(256) }));
  assert.doesNotThrow(() => parseSendMessageRequest({ message: "hi", shout: false, to: "Alex" }));
});

test("a server without /shout answers unknown command: SHOUT_UNAVAILABLE at once, not a timeout", async () => {
  // As seen on a vanilla server (live check 2026-10-18, check 7): red text whose `extra` carries the translation.
  const unknownCommand = { color: "red", extra: [{ translate: "command.unknown.command" }], text: "" };
  const bot = chatBot((_bot, _message, chat) => chat.hearSystem(unknownCommand));
  const output = await new ActionRunner().run(createSendMessageAction(bot), { message: "hello", shout: true });
  assert.equal(output.result.status, "failed");
  assert.match("error" in output.result ? output.result.error : "", /^\[SHOUT_UNAVAILABLE\]/);
  assert.equal(bot.listenerCount("chat"), 0);
  assert.equal(bot.listenerCount("message"), 0);

  // The same reply to plain talk is not a shout problem.
  const quiet = chatHarness(() => {});
  const controller = new AbortController();
  const pending = new ActionRunner().run(createSendMessageAction(quiet.bot), { message: "hello" }, controller.signal);
  quiet.chat.hearSystem(unknownCommand);
  controller.abort(new Error("done"));
  assert.equal((await pending).result.status, "cancelled");
});
