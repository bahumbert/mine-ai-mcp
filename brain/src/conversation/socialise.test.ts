import assert from "node:assert/strict";
import test from "node:test";
import { Body, INSTANT_TYPING } from "../body.ts";
import { FakeRuntime, scriptedMind, testPersona, until } from "../testing.ts";
import { ConversationBudget, ConversationController } from "./controller.ts";
import { pickPartner, socialise, type Clock } from "./socialise.ts";

const OPEN = { open: true, to: ["Theo"], topic: "the mine", length: "medium", say: "Theo! Got a minute?" };
const limits = { openingDistance: 16, talkRange: 64, maxMinutes: 6 };

function setup(localized: boolean, players: FakeRuntime["snapshot"]["players"]) {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, players };
  const { chat, mind } = scriptedMind();
  const spoken: { text: string; shout: boolean }[] = [];
  let now = 1_000_000;
  // Free for the opening call; once a talk runs the queue is "full", so its end takes the topic as the gist.
  const talks = new ConversationController({
    self: "Ayla", persona: testPersona(), mind, budget: new ConversationBudget(2), modelFree: () => talks.current === null, talkRange: 64, localized,
    random: () => 0, now: () => now, speak: (text, _to, _whisperTo, shout) => spoken.push({ text, shout }), journal: () => undefined,
    memorize: () => undefined, log: () => undefined, history: () => [],
  });
  const clock: Clock = { now: () => now, sleep: async (ms) => { now += ms; } };
  const controller = new AbortController();
  const run = (extra: { clock?: Clock; signal?: AbortSignal } = {}) => socialise({
    runtime, signal: extra.signal ?? controller.signal, partner: "Theo", talks,
    context: { runtime, body: new Body(runtime, () => undefined, INSTANT_TYPING), signal: controller.signal, self: "Ayla" },
    openFacts: { activity: "idle", lately: [], lastFailed: null }, limits, since: 0, ...(extra.clock !== undefined && { clock: extra.clock }),
  });
  return { runtime, chat, talks, spoken, clock, run, controller };
}

const theoAt = (x: number) => [{ username: "Theo", position: { x, y: 64, z: 0 } }];

test("pickPartner prefers the named partner, then the nearest, then the first", () => {
  const snapshot = { ...new FakeRuntime().snapshot, players: [{ username: "Bruno", position: { x: 5, y: 64, z: 0 } }, { username: "Theo", position: { x: 40, y: 64, z: 0 } }] };
  assert.equal(pickPartner("go and chat with Theo", ["Bruno", "Theo"], snapshot), "Theo");
  assert.equal(pickPartner("have a chat", ["Theo", "Bruno"], snapshot), "Bruno");
  assert.equal(pickPartner("have a chat", ["Vex", "Cleo"], snapshot), "Vex");
  assert.equal(pickPartner("have a chat", [], snapshot), null);
});

test("goes to the partner, opens, follows until the end", async () => {
  const t = setup(true, theoAt(30));
  t.runtime.durations.navigate = 5;
  t.chat.reply(OPEN);
  const running = t.run();
  await until(() => t.talks.current !== null);
  assert.deepEqual(t.runtime.submitted.map((call) => call.tool).slice(0, 1), ["navigate"], "it walked up first");
  assert.equal(t.spoken[0]?.shout, false, "close enough to hear: not shouted");
  t.talks.said(true);
  const result = await running;
  assert.equal(result.status, "done");
  assert.match(result.status === "done" ? result.detail : "", /^talked with Theo/u);
});

test("calls a partner out of sight with one shout, and gives up after 60 s", async () => {
  const t = setup(true, []);
  t.chat.reply(OPEN);
  const result = await t.run({ clock: t.clock });
  assert.deepEqual(result, { status: "failed", detail: "Theo did not come" });
  assert.equal(t.spoken.length, 1);
  assert.equal(t.spoken[0]?.shout, true);
  assert.equal(t.talks.current, null, "the record ended out_of_range");
});

test("without localized chat the call is a plain line", async () => {
  const t = setup(false, []);
  t.chat.reply(OPEN);
  await t.run({ clock: t.clock });
  assert.equal(t.spoken[0]?.shout, false);
});

test("a partner who comes within the opening distance is talked with", async () => {
  const t = setup(true, []);
  t.chat.reply(OPEN);
  t.runtime.durations.navigate = 5;
  let looks = 0;
  const clock: Clock = { now: t.clock.now, sleep: async () => { looks += 1; if (looks === 2) t.runtime.snapshot = { ...t.runtime.snapshot, players: theoAt(6) }; await new Promise((resolve) => setTimeout(resolve, 2)); } };
  const running = t.run({ clock });
  await until(() => looks >= 3);
  t.talks.said(true);
  assert.equal((await running).status, "done");
});

test("with the agent's tick running, an unanswered call fails once: no second call, no follow", async () => {
  const t = setup(true, []);
  t.chat.reply(OPEN, OPEN);
  const clock: Clock = {
    now: t.clock.now,
    sleep: async (ms, signal) => { await t.clock.sleep(ms, signal); await t.talks.tick(await t.runtime.status(), signal); },
  };
  const result = await t.run({ clock });
  assert.deepEqual(result, { status: "failed", detail: "Theo did not come" });
  assert.equal(t.spoken.length, 1, "one shouted call only");
  assert.deepEqual(t.runtime.submitted.map((call) => call.tool), []);
});

test("resumed after its conversation ended, it finishes without a new opening", async () => {
  const t = setup(true, theoAt(30));
  t.runtime.durations.navigate = 5;
  t.chat.reply(OPEN, { gist: "Talked." }, OPEN);
  const first = t.run();
  await until(() => t.talks.current !== null);
  t.talks.end("out_of_range");
  t.controller.abort();
  await first;
  await t.talks.finished();
  // Set aside while it followed, the record ended meanwhile: run again.
  assert.deepEqual(await t.run({ signal: new AbortController().signal }), { status: "done", detail: "talked with Theo: Talked." });
  assert.equal(t.chat.requests.length, 2, "the first opening and its gist only");
  assert.equal(t.spoken.length, 1);
});

test("a slow gist does not hold the routine", async () => {
  const t = setup(true, theoAt(30));
  t.runtime.durations.navigate = 5;
  t.chat.reply(OPEN);
  t.talks.finished = () => new Promise(() => undefined);
  const waits: number[] = [];
  const clock: Clock = { now: () => waits.reduce((a, b) => a + b, 1_000_000), sleep: async (ms) => { waits.push(ms); await new Promise((resolve) => setTimeout(resolve, 2)); } };
  const running = t.run({ clock });
  await until(() => t.talks.current !== null);
  t.talks.said(true);
  const result = await running;
  assert.equal(result.status, "done");
  assert.match(result.status === "done" ? result.detail : "", /^talked with Theo/u);
});
