import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { runListener, type ListenerBot } from "./listener.ts";

/** A listener test fake: the events mineflayer's `Bot` emits for it (`chat.js` emits `chat`/`whisper` with the sender first, then the text; `kick.js` emits `kicked` with the reason as it came). It is no runtime bot. */
class FakeListenerBot extends EventEmitter {
  readonly username = "MineAI";
  readonly whispered: { to: string; message: string }[] = [];
  whisper(to: string, message: string): void {
    this.whispered.push({ to, message });
  }
}

function start(prefix = "!") {
  const bot = new FakeListenerBot();
  const events: Record<string, unknown>[] = [];
  const listener = runListener(bot as ListenerBot, { emit: (event) => events.push(event as Record<string, unknown>), prefix });
  return { bot, events, listener };
}

const DUPLICATE_KEY = "multiplayer.disconnect.duplicate_login";
const nbtReason = (translate: string) => ({ type: "compound", value: { translate: { type: "string", value: translate } } });

test("joined is emitted once, on the first spawn", () => {
  const { bot, events } = start();
  bot.emit("spawn");
  bot.emit("spawn");
  assert.deepEqual(events, [{ kind: "joined" }]);
});

test("a command line in public chat or a whisper is emitted with its channel", () => {
  const { bot, events } = start();
  bot.emit("chat", "Tom", "!bots");
  bot.emit("whisper", "Ann", "  !BOT stop ayla");
  assert.deepEqual(events, [
    { kind: "command", username: "Tom", channel: "chat", message: "!bots" },
    { kind: "command", username: "Ann", channel: "whisper", message: "  !BOT stop ayla" },
  ]);
});

test("the listener's own line is ignored", () => {
  const { bot, events } = start();
  bot.emit("chat", "MineAI", "!bots");
  assert.deepEqual(events, []);
});

test("lines that are no command line are ignored", () => {
  const { bot, events } = start();
  for (const text of ["hello", "!discord", "!botany", "!! creeper", "hi !bots"]) bot.emit("chat", "Tom", text);
  assert.deepEqual(events, []);
});

test("the prefix is matched as text, never as a pattern", () => {
  const { bot, events } = start(".");
  bot.emit("chat", "Tom", "xbots");
  bot.emit("chat", "Tom", ".bots");
  assert.deepEqual(events, [{ kind: "command", username: "Tom", channel: "chat", message: ".bots" }]);
});

test("a duplicate-login kick given as a JSON string is flagged duplicate", () => {
  const { bot, events } = start();
  bot.emit("kicked", JSON.stringify({ translate: DUPLICATE_KEY }), true);
  assert.deepEqual(events, [{ kind: "ended", reason: DUPLICATE_KEY, duplicate: true, kicked: true }]);
});

test("NBT duplicate reason -> duplicate:true", () => {
  const { bot, events } = start();
  bot.emit("kicked", nbtReason(DUPLICATE_KEY), true);
  assert.deepEqual(events, [{ kind: "ended", reason: DUPLICATE_KEY, duplicate: true, kicked: true }]);
});

const KICK_REASONS: readonly [name: string, raw: unknown, reason: string][] = [
  ["an NBT kick for another reason", nbtReason("multiplayer.disconnect.flying"), "multiplayer.disconnect.flying"],
  ["an NBT whitelist kick (the supervisor stops on this key)", nbtReason("multiplayer.disconnect.not_whitelisted"), "multiplayer.disconnect.not_whitelisted"],
  ["a JSON-string ban kick (the supervisor stops on this key)", JSON.stringify({ translate: "multiplayer.disconnect.banned" }), "multiplayer.disconnect.banned"],
  ["a plain-text kick", "You are not white-listed on this server!", "You are not white-listed on this server!"],
  ["a text component", JSON.stringify({ text: "Banned by an operator" }), "Banned by an operator"],
  ["an empty text with extra parts", JSON.stringify({ text: "", extra: [{ text: "You are banned: griefing" }] }), "You are banned: griefing"],
  ["a translation with arguments", JSON.stringify({ translate: "multiplayer.disconnect.banned.reason", with: ["griefing"] }), "multiplayer.disconnect.banned.reason: griefing"],
];

for (const [name, raw, reason] of KICK_REASONS) {
  test(`${name} ends the listener with the server's own words and no duplicate flag`, () => {
    const { bot, events } = start();
    bot.emit("kicked", raw, true);
    assert.deepEqual(events, [{ kind: "ended", reason, duplicate: false, kicked: true }]);
  });
}

test("end after kicked -> one ended", () => {
  const { bot, events } = start();
  bot.emit("kicked", nbtReason(DUPLICATE_KEY), true);
  bot.emit("end", "socketClosed");
  assert.equal(events.filter((event) => event.kind === "ended").length, 1);
});

test("end alone is an ended that is no kick", () => {
  const { bot, events } = start();
  bot.emit("end", "socketClosed");
  assert.deepEqual(events, [{ kind: "ended", reason: "socketClosed", duplicate: false, kicked: false }]);
});

test("a connection error ends the listener once, even when end follows", () => {
  const { bot, events } = start();
  bot.emit("error", new Error("connect ECONNREFUSED 127.0.0.1:25565"));
  bot.emit("end", "socketClosed");
  assert.deepEqual(events, [{ kind: "ended", reason: "connect ECONNREFUSED 127.0.0.1:25565", duplicate: false, kicked: false }]);
});

test("nothing is emitted after ended", () => {
  const { bot, events } = start();
  bot.emit("end", "socketClosed");
  bot.emit("chat", "Tom", "!bots");
  bot.emit("spawn");
  assert.equal(events.length, 1);
});

test("whisper sends text to a player through the bot", () => {
  const { bot, listener } = start();
  listener.whisper("Tom", "Not started: Brea");
  assert.deepEqual(bot.whispered, [{ to: "Tom", message: "Not started: Brea" }]);
});

test("whisper refuses what the server would disconnect the bot for and a bad target; exactly 233 characters pass", () => {
  const { bot, listener } = start();
  for (const message of ["a".repeat(234), "a§b", "a\nb", "a\u007fb", ""]) listener.whisper("Tom", message);
  listener.whisper("Tom\nop Tom", "hi");
  listener.whisper("", "hi");
  assert.deepEqual(bot.whispered, []);
  listener.whisper("Tom", "a".repeat(233));
  assert.equal(bot.whispered.length, 1);
});
