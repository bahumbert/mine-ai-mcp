import assert from "node:assert/strict";
import test from "node:test";
import type { ChatLine } from "../mind.ts";
import type { BotSnapshot } from "../runtime-client.ts";
import { FakeRuntime, scriptedMind, testPersona } from "../testing.ts";
import { ConversationBudget, ConversationController, maxConversations, type ConversationEvent, type ConversationMemory } from "./controller.ts";

const signal = new AbortController().signal;
const OPEN = { open: true, to: ["Theo"], topic: "the mine", length: "short", say: "Theo! How's the mine?" };

function setup(options: { random?: number; budget?: ConversationBudget; modelFree?: () => boolean; localized?: boolean; history?: ChatLine[] } = {}) {
  const { chat, mind } = scriptedMind();
  const clock = { now: 1_000_000 };
  const spoken: { text: string; to: readonly string[]; whisperTo: string | null; shout: boolean }[] = [];
  const journal: ConversationEvent[] = [];
  const memories: ConversationMemory[] = [];
  const logs: string[] = [];
  const budget = options.budget ?? new ConversationBudget(2);
  const draw = { value: options.random ?? 0.1 };
  const controller = new ConversationController({
    self: "Ayla", persona: testPersona(), mind, budget, modelFree: options.modelFree ?? (() => true), talkRange: 64,
    ...(options.localized !== undefined && { localized: options.localized }), random: () => draw.value, now: () => clock.now,
    speak: (text, to, whisperTo, shout) => spoken.push({ text, to, whisperTo, shout }),
    journal: (event) => journal.push(event), memorize: (memory) => memories.push(memory), log: (line) => logs.push(line),
    history: () => options.history ?? [],
  });
  const snapshotWith = (players: BotSnapshot["players"]): BotSnapshot => ({ ...new FakeRuntime().snapshot, position: { x: 0, y: 64, z: 0 }, players });
  const theoAt = (blocks: number) => snapshotWith([{ username: "Theo", position: { x: blocks, y: 64, z: 0 } }]);
  const facts = (snapshot: BotSnapshot) => ({ snapshot, activity: "idle", lately: [], lastFailed: null, busy: false });
  return { chat, controller, clock, spoken, journal, memories, logs, budget, draw, snapshotWith, theoAt, facts };
}

test("no model call when nobody is within 16 blocks, the draw fails, or it is busy, the queue full or too soon", async () => {
  let free = true;
  const t = setup({ modelFree: () => free });
  t.chat.reply(OPEN, OPEN, OPEN, OPEN, OPEN);
  assert.equal(await t.controller.maybeOpen(t.facts(t.theoAt(17)), signal), false, "17 blocks");
  assert.equal(await t.controller.maybeOpen(t.facts(t.snapshotWith([])), signal), false, "nobody");
  t.clock.now += 30_000;
  t.draw.value = 0.5;
  assert.equal(await t.controller.maybeOpen(t.facts(t.theoAt(10)), signal), false, "the draw fails");
  t.clock.now += 30_000;
  t.draw.value = 0.1;
  assert.equal(await t.controller.maybeOpen({ ...t.facts(t.theoAt(10)), busy: true }, signal), false, "busy");
  free = false;
  assert.equal(await t.controller.maybeOpen(t.facts(t.theoAt(10)), signal), false, "queue full");
  free = true;
  t.clock.now += 10_000;
  assert.equal(t.chat.requests.length, 0, "no model call at all");
  assert.ok(t.logs.some((line) => line === "conversation: chance 0.30 drew no"));
});

test("no model call before 30 s since the last check", async () => {
  const t = setup({ random: 0.5 });
  t.chat.reply(OPEN);
  await t.controller.maybeOpen(t.facts(t.theoAt(10)), signal);
  t.clock.now += 29_999;
  t.draw.value = 0;
  assert.equal(await t.controller.maybeOpen(t.facts(t.theoAt(10)), signal), false);
  assert.equal(t.chat.requests.length, 0);
});

test("no model call at the budget cap", async () => {
  const budget = new ConversationBudget(1);
  assert.equal(budget.tryTake(), true);
  const t = setup({ budget });
  assert.equal(await t.controller.maybeOpen(t.facts(t.theoAt(10)), signal), false);
  assert.equal(t.chat.requests.length, 0);
});

test("opens on yes: one line to Theo, a record with both, an opened row", async () => {
  const t = setup();
  t.chat.reply(OPEN);
  assert.equal(await t.controller.maybeOpen(t.facts(t.theoAt(10)), signal), true);
  assert.deepEqual(t.spoken, [{ text: "Theo! How's the mine?", to: ["Theo"], whisperTo: null, shout: false }]);
  assert.deepEqual(t.controller.current?.members, ["Ayla", "Theo"]);
  assert.equal(t.controller.current?.lines, 1);
  assert.deepEqual(t.journal, [{ kind: "conversation", event: "opened", id: t.controller.current!.id, members: ["Ayla", "Theo"], conversationKind: "chance", topic: "the mine", planned: "short" }]);
  assert.equal(t.budget.active, 1);
});

test("budget given back on open: false, an empty line or an error", async () => {
  const t = setup();
  t.chat.reply({ open: false }, { ...OPEN, say: "" });
  assert.equal(await t.controller.maybeOpen(t.facts(t.theoAt(10)), signal), false);
  assert.equal(t.budget.active, 0);
  t.clock.now += 30_000;
  assert.equal(await t.controller.maybeOpen(t.facts(t.theoAt(10)), signal), false);
  assert.equal(t.budget.active, 0);
  t.clock.now += 30_000;
  t.chat.reply("not json", "still not", "nor this");
  assert.equal(await t.controller.maybeOpen(t.facts(t.theoAt(10)), signal), false);
  assert.equal(t.budget.active, 0);
  assert.deepEqual(t.spoken, []);
});

test("pair cooldown: Theo again after an end waits 10 minutes", async () => {
  const t = setup();
  t.chat.reply(OPEN, { gist: "Chatted." }, OPEN);
  await t.controller.maybeOpen(t.facts(t.theoAt(10)), signal);
  t.controller.end("goodbye");
  await t.controller.finished();
  assert.equal(t.budget.active, 0);
  t.clock.now += 9 * 60_000;
  t.draw.value = 0;
  assert.equal(await t.controller.maybeOpen(t.facts(t.theoAt(10)), signal), false);
  assert.equal(t.chat.requests.length, 2, "the opening and the gist only");
  t.clock.now += 61_000;
  assert.equal(await t.controller.maybeOpen(t.facts(t.theoAt(10)), signal), true);
});

test("heard: a line naming her opens a record by its speaker; a non-member naming a member joins", () => {
  const t = setup();
  t.controller.heard("Theo", "Ayla, hi", ["Ayla"], "chat");
  assert.deepEqual(t.controller.current?.members, ["Ayla", "Theo"]);
  assert.equal(t.controller.current?.opener, "Theo");
  assert.equal(t.controller.current?.lines, 1);
  assert.equal(t.budget.active, 0, "not opened by her: no budget");
  t.controller.heard("Bruno", "Theo, wait for me", ["Theo"], "chat");
  assert.deepEqual(t.controller.current?.members, ["Ayla", "Theo", "Bruno"]);
  assert.equal(t.journal.at(-1)?.event, "joined");
  t.controller.heard("Cleo", "nice weather", [], "chat");
  assert.equal(t.controller.isMember("Cleo"), false);
  assert.equal(t.controller.current?.lines, 2);
});

test("a whisper opens a whisper record", () => {
  const t = setup();
  t.controller.heard("Theo", "psst Ayla", ["Ayla"], "whisper");
  assert.equal(t.controller.current?.whisper, true);
});

test("own line is not heard as a member's", () => {
  const t = setup();
  t.controller.heard("Theo", "Ayla, hi", ["Ayla"], "chat");
  const before = t.controller.current!.lines;
  t.controller.heard("Ayla", "hello Theo", ["Theo"], "chat");
  assert.equal(t.controller.current!.lines, before);
  const fresh = setup();
  fresh.controller.heard("Ayla", "hello Theo", ["Ayla", "Theo"], "chat");
  assert.equal(fresh.controller.current, null);
});

test("said with close ends the conversation as goodbye, and journals it with the gist", async () => {
  const t = setup({ history: [{ speaker: "Theo", text: "see you", at: 1_000_001 }] });
  t.chat.reply({ gist: "Talked about nothing much." });
  t.controller.heard("Theo", "Ayla, hi", ["Ayla"], "chat");
  t.clock.now += 5_000;
  t.controller.said(true);
  assert.equal(t.controller.current, null);
  await t.controller.finished();
  const ended = t.journal.at(-1);
  assert.equal(ended?.event, "ended");
  assert.equal(ended?.reason, "goodbye");
  assert.equal(ended?.lines, 2);
  assert.equal(ended?.gist, "Talked about nothing much.");
  assert.deepEqual(t.memories[0]?.talk.members, ["Theo"], "the memory holds the others only");
  assert.match(t.chat.requests[0]?.[1]?.content ?? "", /Theo: "see you"/u);
});

test("after the cap, her next line ends it as cap", () => {
  const t = setup({ modelFree: () => false });
  t.controller.heard("Theo", "Ayla, hi", ["Ayla"], "chat");
  for (let line = 0; line < 23; line += 1) t.controller.heard("Theo", "and", [], "chat");
  assert.equal(t.controller.facts()?.sayGoodbye, true);
  t.controller.said(false);
  assert.equal(t.controller.current, null);
  assert.equal(t.journal.at(-1)?.reason, "cap");
});

test("tick ends out_of_range after 20 s alone", async () => {
  const t = setup({ modelFree: () => false });
  t.controller.heard("Theo", "Ayla, hi", ["Ayla"], "chat");
  await t.controller.tick(t.snapshotWith([]), signal);
  assert.notEqual(t.controller.current, null);
  t.clock.now += 20_000;
  await t.controller.tick(t.snapshotWith([]), signal);
  assert.equal(t.controller.current, null);
  assert.deepEqual(t.journal.map((event) => event.event), ["opened", "left", "ended"]);
  assert.equal(t.journal.at(-1)?.reason, "out_of_range");
});

test("gist falls back to the topic when the queue is full", async () => {
  let free = true;
  const t = setup({ modelFree: () => free });
  t.chat.reply(OPEN);
  await t.controller.maybeOpen(t.facts(t.theoAt(10)), signal);
  free = false;
  t.controller.end("silence");
  assert.equal(t.chat.requests.length, 1, "only the opening");
  assert.equal(t.memories[0]?.talk.gist, "the mine");
  const opened = setup({ modelFree: () => false });
  opened.controller.heard("Theo", "Ayla, the mine?", ["Ayla"], "chat");
  opened.controller.end("silence");
  assert.equal(opened.memories[0]?.talk.gist, "", "no topic: no gist");
});

test("the last talks feed the next opening and the conversation block", async () => {
  const t = setup();
  t.controller.recalled([{ members: ["Theo"], topic: "iron", gist: "I promised logs", endedAt: new Date(t.clock.now - 12 * 60_000).toISOString() }]);
  t.chat.reply(OPEN);
  await t.controller.maybeOpen(t.facts(t.theoAt(10)), signal);
  assert.match(t.chat.requests[0]?.[1]?.content ?? "", /12 min ago about iron: I promised logs/u);
  assert.equal(t.controller.facts()?.lastGists[0]?.gist, "I promised logs");
});

test("a social opening skips the draw, calls out of earshot with a shout when localized chat is on", async () => {
  const t = setup({ random: 0.99, localized: true });
  t.chat.reply({ ...OPEN, say: "Theo! Come over!" });
  assert.equal(await t.controller.openSocial("Theo", null, t.facts(t.snapshotWith([])), signal), true);
  assert.equal(t.spoken[0]?.shout, true);
  assert.equal(t.controller.current?.kind, "social");
  assert.equal(t.controller.current?.waitUntil, t.clock.now + 60_000);
  assert.match(t.chat.requests[0]?.[1]?.content ?? "", /out of earshot/u);
  const plain = setup({ localized: false });
  plain.chat.reply(OPEN);
  await plain.controller.openSocial("Theo", null, plain.facts(plain.snapshotWith([])), signal);
  assert.equal(plain.spoken[0]?.shout, false);
});

test("--max-conversations: default 2, 0 accepted, a negative or fractional value is refused", () => {
  assert.equal(maxConversations(undefined), 2);
  assert.equal(maxConversations("0"), 0);
  assert.equal(maxConversations("3"), 3);
  for (const bad of ["-1", "1.5", "two", ""]) assert.throws(() => maxConversations(bad), /\[BAD_START_ARG\]/u);
});

test("a social opening is skipped, without a model call, when the model queue is full", async () => {
  const t = setup({ modelFree: () => false });
  t.chat.reply(OPEN);
  assert.equal(await t.controller.openSocial("Theo", null, t.facts(t.snapshotWith([])), signal), false);
  assert.equal(t.chat.requests.length, 0);
  assert.equal(t.budget.active, 0);
});

test("simultaneous openings: the username that sorts later takes the other as opener and gives its budget slot back", async () => {
  const t = setup();
  const aaron = { username: "Aaron", position: { x: 5, y: 64, z: 0 } };
  t.chat.reply({ ...OPEN, to: ["Aaron"] });
  await t.controller.maybeOpen(t.facts(t.snapshotWith([aaron])), signal);
  assert.equal(t.budget.active, 1);
  t.controller.heard("Aaron", "Ayla, hi", ["Ayla"], "chat");
  assert.equal(t.controller.current?.opener, "Aaron");
  assert.equal(t.controller.current?.planned, null);
  assert.equal(t.controller.current?.topic, "");
  assert.equal(t.controller.current?.lines, 2);
  assert.equal(t.budget.active, 0);
  assert.equal(t.controller.facts()?.iAmOpener, false);
});

test("simultaneous openings: the username that sorts first keeps its record and its slot", async () => {
  const t = setup();
  const zed = { username: "Zed", position: { x: 5, y: 64, z: 0 } };
  t.chat.reply({ ...OPEN, to: ["Zed"] });
  await t.controller.maybeOpen(t.facts(t.snapshotWith([zed])), signal);
  t.controller.heard("Zed", "Ayla, hi", ["Ayla"], "chat");
  assert.equal(t.controller.current?.opener, "Ayla");
  assert.equal(t.budget.active, 1);
  assert.equal(t.controller.current?.lines, 2);
});

test("a nameless line from someone within talk range joins; from farther away or unknown, it does not", () => {
  const t = setup();
  t.controller.heard("Theo", "Ayla, hi", ["Ayla"], "chat");
  t.controller.heard("Steve", "nice day", [], "chat", false);
  t.controller.heard("Cleo", "hello", [], "chat");
  assert.deepEqual(t.controller.current?.members, ["Ayla", "Theo"]);
  t.controller.heard("Steve", "nice day", [], "chat", true);
  assert.deepEqual(t.controller.current?.members, ["Ayla", "Theo", "Steve"]);
  assert.equal(t.journal.at(-1)?.event, "joined");
  const alone = setup();
  alone.controller.heard("Steve", "nice day", [], "chat", true);
  assert.equal(alone.controller.current, null, "near alone opens nothing");
});
