import assert from "node:assert/strict";
import test from "node:test";
import { Body, INSTANT_TYPING } from "../body.ts";
import { createFakeClock, type FakeClock } from "../../../src/test-support/fake-bot/fake-clock.ts";
import { FakeRuntime, scriptedMind, testPersona } from "../testing.ts";
import { ConversationBudget, ConversationController } from "./controller.ts";
import { monotonicClock, pickPartner, realClock, socialise, type Clock } from "./socialise.ts";

const OPEN = { open: true, to: ["Theo"], topic: "the mine", length: "medium", say: "Theo! Got a minute?" };
const limits = { openingDistance: 16, talkRange: 64, maxMinutes: 6 };
/** The slice the fake clock moves in while a test waits for a state (the runtime fake's own wait is 1 ms). */
const SLICE_MS = 50;

/** Moves the fake clock on until `condition` holds (a state, not a duration); fails naming `maxMs` of clock when it never does. */
async function advanceUntil(clock: FakeClock, condition: () => boolean, maxMs = 2_000): Promise<void> {
  for (let passed = 0; !condition(); passed += SLICE_MS) {
    if (passed >= maxMs) throw new Error(`condition not reached within ${maxMs} ms of clock`);
    await clock.advance(SLICE_MS, SLICE_MS);
  }
}

function setup(localized: boolean, players: FakeRuntime["snapshot"]["players"]) {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, players };
  const { chat, mind } = scriptedMind();
  const spoken: { text: string; shout: boolean }[] = [];
  let now = 1_000_000;
  // The wall time is `now + wall.offset`: a test steps the wall clock by moving the offset.
  const wall = { offset: 0 };
  // Free for the opening call; once a talk runs the queue is "full", so its end takes the topic as the gist.
  const budget = new ConversationBudget(2);
  const talks = new ConversationController({
    self: "Ayla", persona: testPersona(), mind, budget, modelFree: () => talks.current === null, talkRange: 64, localized,
    random: () => 0, now: () => now, wallNow: () => now + wall.offset, speak: async (text, _to, _whisperTo, shout) => { spoken.push({ text, shout }); }, journal: () => undefined,
    memorize: () => undefined, log: () => undefined, history: () => [],
  });
  const clock: Clock = { now: () => now, sleep: async (ms) => { now += ms; } };
  const controller = new AbortController();
  const run = (extra: { clock?: Clock; signal?: AbortSignal; openWaitMs?: number; since?: number } = {}) => socialise({
    runtime, signal: extra.signal ?? controller.signal, partner: "Theo", talks,
    context: { runtime, body: new Body(runtime, () => undefined, INSTANT_TYPING), signal: controller.signal, self: "Ayla" },
    openFacts: { activity: "idle", lately: [], lastFailed: null }, limits, since: extra.since ?? 0, ...(extra.openWaitMs !== undefined && { openWaitMs: extra.openWaitMs }), ...(extra.clock !== undefined && { clock: extra.clock }),
  });
  return { runtime, chat, talks, spoken, clock, run, controller, budget, wall, now: () => now };
}

const theoAt = (x: number) => [{ username: "Theo", position: { x, y: 64, z: 0 } }];

test("pickPartner prefers the named partner, then the nearest, then the first", () => {
  const snapshot = { ...new FakeRuntime().snapshot, players: [{ username: "Bruno", position: { x: 5, y: 64, z: 0 } }, { username: "Theo", position: { x: 40, y: 64, z: 0 } }] };
  assert.equal(pickPartner("go and chat with Theo", ["Bruno", "Theo"], snapshot), "Theo");
  assert.equal(pickPartner("have a chat", ["Theo", "Bruno"], snapshot), "Bruno");
  assert.equal(pickPartner("have a chat", ["Vex", "Cleo"], snapshot), "Vex");
  assert.equal(pickPartner("have a chat", [], snapshot), null);
});

test("the routine's own sleep ends on an abort, before or during the wait, without throwing and with no timer left", async () => {
  const fake = createFakeClock({ mode: "mocked" });
  using _timers = fake.install();
  for (const clock of [realClock, monotonicClock]) {
    const before = new AbortController();
    before.abort();
    await clock.sleep(1_000, before.signal);
    assert.equal(fake.pendingGlobalTimers(), 0, "an aborted signal starts no timer");
    const during = new AbortController();
    fake.after(10, () => during.abort());
    const started = fake.now();
    await fake.settle(clock.sleep(1_000, during.signal), 1_000, 10);
    assert.ok(fake.now() - started <= 10, "it ended at the abort, not after its 1 s");
    assert.equal(fake.pendingGlobalTimers(), 0, "the abort cleared the wait's timer");
  }
});

test("goes to the partner, opens, follows until the end", async () => {
  const fake = createFakeClock({ mode: "mocked" });
  using _timers = fake.install();
  const t = setup(true, theoAt(30));
  t.runtime.durations.navigate = 5;
  t.chat.reply(OPEN);
  const running = t.run();
  await advanceUntil(fake, () => t.talks.current !== null);
  assert.deepEqual(t.runtime.submitted.map((call) => call.tool).slice(0, 1), ["navigate"], "it walked up first");
  assert.equal(t.spoken[0]?.shout, false, "close enough to hear: not shouted");
  t.talks.said(true);
  const result = await fake.settle(running, 5_000);
  assert.equal(result.status, "done");
  assert.match(result.status === "done" ? result.detail : "", /^talked with Theo/u);
});

test("calls a partner out of sight with one shout, and gives up after 60 s", async () => {
  const t = setup(true, []);
  t.chat.reply(OPEN);
  const result = await t.run({ clock: t.clock });
  assert.deepEqual(result, { status: "failed", detail: "Theo did not come", reason: "did_not_come" });
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
  const fake = createFakeClock({ mode: "mocked" });
  using _timers = fake.install();
  const t = setup(true, []);
  t.chat.reply(OPEN);
  t.runtime.durations.navigate = 5;
  let looks = 0;
  const clock: Clock = { now: t.clock.now, sleep: async (ms, signal) => { looks += 1; if (looks === 2) t.runtime.snapshot = { ...t.runtime.snapshot, players: theoAt(6) }; await fake.sleep(ms, signal); } };
  const running = t.run({ clock });
  await advanceUntil(fake, () => looks >= 3, 10_000);
  t.talks.said(true);
  assert.equal((await fake.settle(running, 5_000)).status, "done");
});

test("with the agent's tick running, an unanswered call fails once: no second call, no follow", async () => {
  const t = setup(true, []);
  t.chat.reply(OPEN, OPEN);
  const clock: Clock = {
    now: t.clock.now,
    sleep: async (ms, signal) => { await t.clock.sleep(ms, signal); await t.talks.tick(await t.runtime.status(), signal); },
  };
  const result = await t.run({ clock });
  assert.deepEqual(result, { status: "failed", detail: "Theo did not come", reason: "did_not_come" });
  assert.equal(t.spoken.length, 1, "one shouted call only");
  assert.deepEqual(t.runtime.submitted.map((call) => call.tool), []);
});

test("resumed after its conversation ended, it finishes without a new opening", async () => {
  const fake = createFakeClock({ mode: "mocked" });
  using _timers = fake.install();
  const t = setup(true, theoAt(30));
  t.runtime.durations.navigate = 5;
  t.chat.reply(OPEN, { gist: "Talked." }, OPEN);
  const first = t.run();
  await advanceUntil(fake, () => t.talks.current !== null);
  t.talks.end("out_of_range");
  t.controller.abort();
  await fake.settle(first, 5_000);
  await fake.settle(t.talks.finished(), 5_000);
  // Set aside while it followed, the record ended meanwhile: run again.
  assert.deepEqual(await fake.settle(t.run({ signal: new AbortController().signal }), 5_000), { status: "done", detail: "talked with Theo: Talked." });
  assert.equal(t.chat.requests.length, 2, "the first opening and its gist only");
  assert.equal(t.spoken.length, 1);
});

test("a slow gist does not hold the routine", async () => {
  const fake = createFakeClock({ mode: "mocked" });
  using _timers = fake.install();
  const t = setup(true, theoAt(30));
  t.runtime.durations.navigate = 5;
  t.chat.reply(OPEN);
  t.talks.finished = () => new Promise(() => undefined);
  const waits: number[] = [];
  const clock: Clock = { now: () => waits.reduce((a, b) => a + b, 1_000_000), sleep: async (ms, signal) => { waits.push(ms); await fake.sleep(ms, signal); } };
  const running = t.run({ clock });
  await advanceUntil(fake, () => t.talks.current !== null);
  t.talks.said(true);
  // The report waits GIST_REPORT_MS (10 s) for a gist that never comes: after the follow poll (1 s) that sees the talk over, 10 s and no more.
  const result = await fake.settle(running, 11_500, 500);
  assert.ok(waits.includes(10_000), "it waited the 10 s report window");
  assert.equal(result.status, "done");
  assert.match(result.status === "done" ? result.detail : "", /^talked with Theo/u);
});

test("a full conversation cap with no wait fails at once: 'had nothing to say', with the reason", async () => {
  const t = setup(true, theoAt(3));
  t.budget.tryTake();
  t.budget.tryTake();
  const result = await t.run();
  assert.deepEqual(result, { status: "failed", detail: "had nothing to say to Theo (conversation limit)", reason: "no_talk" });
});

test("with openWaitMs the routine waits for a conversation slot and then opens", async () => {
  const fake = createFakeClock({ mode: "mocked" });
  using _timers = fake.install();
  const t = setup(true, theoAt(3));
  t.budget.tryTake();
  t.budget.tryTake();
  t.chat.reply(OPEN);
  fake.after(30, () => t.budget.give());
  const running = t.run({ openWaitMs: 5_000 });
  // The controller looks again at the slot every OPEN_POLL_MS (1 s) of clock.
  await advanceUntil(fake, () => t.talks.current !== null, 2_000);
  t.talks.said(true);
  assert.equal((await fake.settle(running, 5_000)).status, "done");
});

test("with openWaitMs a cap that stays full fails at the deadline with the reason", async () => {
  const fake = createFakeClock({ mode: "mocked" });
  using _timers = fake.install();
  const t = setup(true, theoAt(3));
  t.budget.tryTake();
  t.budget.tryTake();
  const result = await fake.settle(t.run({ openWaitMs: 60 }), 60);
  assert.deepEqual(result, { status: "failed", detail: "had nothing to say to Theo (conversation limit)", reason: "no_talk" });
});

// The two clocks (monotonic-clock.ts header): the call's wait is a window (monotonic); `since` is compared with a talk's end (wall).
test("the call's 60 s wait (default clock) ends on monotonic time although the wall clock steps back at each poll", async () => {
  const fake = createFakeClock({ mode: "mocked" });
  using _timers = fake.install();
  const s = setup(true, []);
  s.chat.reply(OPEN);
  // Every look at the partner goes with a 2 s step back of the wall clock, as WSL does: a deadline read from the wall
  // clock would never come (the wall time moves back as much as the poll moves on), the monotonic one comes at 60 s.
  const status = s.runtime.status.bind(s.runtime);
  s.runtime.status = async () => {
    fake.stepWallClock(-2_000);
    return status();
  };
  // 62 s of clock: the 60 s wait and one poll (2 s); in slices of a poll.
  assert.deepEqual(await fake.settle(s.run(), 62_000, 2_000), { status: "failed", detail: "Theo did not come", reason: "did_not_come" });
});

test("a talk that ended since the objective started is the one it came for: the end and the start are both wall times", async () => {
  const t = setup(true, theoAt(3));
  t.wall.offset = 1_700_000_000_000;
  const startedWall = t.now() + t.wall.offset;
  t.chat.reply({ gist: "Talked." });
  t.talks.heard("Theo", "Ayla, hi", ["Ayla"], "chat");
  await t.clock.sleep(5_000, t.controller.signal);
  t.wall.offset -= 2_000;
  t.talks.end("silence");
  await t.talks.finished();
  assert.deepEqual(await t.run({ since: startedWall }), { status: "done", detail: "talked with Theo: Talked." });
  assert.equal(t.spoken.length, 0, "it opened nothing new");
});
