// Concurrent situation decisions and the work loop's fences around their answers.
import assert from "node:assert/strict";
import test from "node:test";
import { createFakeClock, flush } from "../../../src/test-support/fake-bot/fake-clock.ts";
import { describeStep, stepKey } from "../actions.ts";
import { testPersona } from "../testing.ts";
import { say } from "./agent-fixtures.test.ts";
import { CARRY, FETCH, HOME, ordinary, reaches, setup } from "./situation-fixtures.test.ts";
import { newWork } from "./work.ts";

for (const reply of ["done", "give_up", "unusable"] as const) test(`dusk asks while the step runs; ${reply} carries on without changing work`, async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const h = setup(clock);
  h.runtime.durations.collect_block = 100;
  const work = ordinary(h);
  h.hold()();
  const answer = h.hold();
  h.action.reply(FETCH, ...(reply === "done" ? [CARRY] : reply === "give_up" ? [{ give_up: "keep going" }] : Array(6).fill("nope")));
  try {
    await h.start();
    await reaches(clock, () => h.runtime.submitted.some((call) => call.tool === "collect_block"));
    await h.night();
    assert.equal(h.action.requests.length, 2, "the event asks beside get_items");
    assert.equal(work.running?.controller.signal.aborted, false);
    assert.deepEqual(h.runtime.cancelled, [], "raising cancels nothing");
    await clock.advance(250);
    answer();
    await reaches(clock, () => h.situations().some((event) => event.event === "decided"));
    h.hold();
    assert.deepEqual(h.stack, [work]);
    assert.equal(work.running?.controller.signal.aborted, false);
    const decided = h.situations().find((event) => event.event === "decided");
    assert.equal(decided?.answer, reply === "unusable" ? "no usable answer" : "carried on");
    assert.ok((decided?.latencyMs ?? 0) >= 250);
    await h.sample({ clock: { timeOfDay: 14_000, phase: "night", minutesUntilChange: 8, sleeping: false } });
    assert.equal(h.situations().filter((event) => event.event === "raised").length, 1, "one ask in the night");
    assert.equal(h.action.requests.length, reply === "unusable" ? 7 : 2);
    await reaches(clock, () => work.steps.length === 1);
    assert.equal(work.steps[0]?.outcome, "done", "the original get_items finishes normally");
  } finally { await h.stop(); }
});

test("an answer to go home pushes the situation and runs go_to with no extra model call", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const h = setup(clock);
  const work = ordinary(h);
  h.action.reply(FETCH, HOME);
  try {
    await h.start();
    await reaches(clock, () => h.runtime.submitted.some((call) => call.tool === "collect_block"));
    await h.night();
    await reaches(clock, () => h.runtime.submitted.some((call) => call.tool === "navigate"));
    assert.deepEqual(h.stack.map((entry) => entry.situation?.info.kind ?? "own"), ["own", "night"]);
    assert.equal(h.action.requests.length, 2);
    assert.equal(work.steps[0]?.outcome, "interrupted");
    assert.equal(h.stack[1]?.taken, 1);
  } finally { await h.stop(); }
});

test("the step ends before the answer: the next step waits", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const h = setup(clock);
  h.runtime.durations.collect_block = 20;
  h.runtime.durations.navigate = 0;
  h.runtime.walkOnNavigate = true;
  const work = ordinary(h);
  h.hold()();
  const answer = h.hold();
  h.action.reply(FETCH, CARRY, HOME, { done: "arrived" });
  try {
    await h.start();
    await reaches(clock, () => h.runtime.submitted.some((call) => call.tool === "collect_block"));
    await h.night();
    await reaches(clock, () => work.steps.length === 1);
    assert.equal(work.steps[0]?.outcome, "done");
    assert.equal(h.action.requests.length, 2, "no next decision before the event answer");
    answer();
    await reaches(clock, () => work.steps.length === 2);
    assert.equal(work.steps[1]?.outcome, "done", "the next action finishes after carry-on");
    assert.equal(h.runtime.snapshot.position.x, 100);
    assert.equal(work.running, null);
    assert.equal(work.step, null);
  } finally { await h.stop(); }
});

for (const kind of ["work", "refused work", "repeated work", "goal"] as const) for (const answerFirst of [false, true]) for (const carry of [false, true]) test(`${kind} answer ${answerFirst ? "after" : "before"} held event answer: ${carry ? "accepted after carry-on" : "dropped when a situation is pushed"}`, async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const goal = kind === "goal";
  const refused = kind === "refused work";
  const repeated = kind === "repeated work";
  const h = setup(clock, goal ? { persona: testPersona({ goal: "make a home" }) } : {});
  const work = goal ? null : ordinary(h, kind === "work" ? null : "Bob");
  const key = stepKey(FETCH.step);
  const label = describeStep(FETCH.step);
  if (refused) for (let i = 0; i < 2; i++) h.agent["failedSteps"].remember(work!.objective, label, key, "blocked", "", h.runtime.snapshot.position);
  if (repeated) {
    work!.steps.push({ step: label, outcome: "done", detail: "collected 2 oak_log" });
    work!.carried.push("");
  }
  const workAnswer = goal ? h.planner.hold() : h.hold();
  const eventAnswer = h.hold();
  const eventReply = carry ? CARRY : HOME;
  const replies = Array(refused ? 3 : repeated ? 2 : 1).fill(FETCH);
  if (goal) {
    h.planner.reply({ objective: "get 2 oak logs", for: "woodcutting" });
    h.action.reply(eventReply, FETCH);
  } else h.action.reply(...(answerFirst ? [eventReply, ...replies] : [...replies, eventReply]));
  h.chat.reply({ say: "I cannot get those logs." });
  try {
    await h.start();
    await reaches(clock, () => (goal ? h.planner : h.action).requests.length === 1);
    await h.night();
    assert.equal(h.action.requests.length, goal ? 1 : 2);
    assert.deepEqual(h.runtime.cancelled, []);
    if (answerFirst) eventAnswer(); else workAnswer();
    await flush();
    assert.equal(h.runtime.submitted.filter((call) => call.tool === "collect_block" || call.tool === "navigate").length, 0, "no step starts ahead of both answers");
    assert.equal(h.events.some((event) => event.kind === "objective" && event.event === "own"), false);
    assert.equal(work?.refused.size ?? 0, 0, "pending event fences refusal mutations");
    assert.equal(work?.sentBackSteps.size ?? 0, 0, "pending event fences send-back memory");
    if (answerFirst) workAnswer(); else eventAnswer();
    await reaches(clock, () => carry && refused ? !h.stack.includes(work!) : h.runtime.submitted.some((call) => call.tool === (carry ? "collect_block" : "navigate")));
    if (work !== null) {
      assert.equal(work.badReplies, 0);
      assert.equal(work.taken, carry && !refused ? 1 : 0);
      assert.equal(work.refused.get(key) ?? 0, carry && refused ? 3 : 0);
      assert.equal(work.sentBackSteps.has(label), carry && repeated);
      assert.equal(h.stack.includes(work), !(carry && refused));
      assert.equal(h.events.some((event) => event.kind === "objective" && event.event === "finished"), carry && refused);
    } else assert.equal(h.events.some((event) => event.kind === "objective" && event.event === "own"), carry);
    assert.equal(h.logs.some((line) => line.includes("work loop error")), false);
    assert.equal(h.runtime.submitted.filter((call) => call.tool === "collect_block").length, carry && !refused ? 1 : 0);
  } finally { workAnswer(); await h.stop(); }
});

for (const errorFirst of [false, true]) test(`unusable work reply ${errorFirst ? "before a held situation answer" : "after situation push"} does not count or finish the set-aside order`, async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const h = setup(clock);
  const work = ordinary(h, "Bob");
  work.badReplies = 1;
  work.taken = h.agent["options"].persona.settings.maxSameStepInARow - 1;
  work.failing = { skill: "get_items", count: h.agent["options"].persona.settings.maxSkillFailuresInARow - 1 };
  const before = { taken: work.taken, failing: { ...work.failing } };
  const workAnswer = h.hold();
  const eventAnswer = h.hold();
  h.action.reply(...(errorFirst ? ["nope", "nope", "nope", HOME] : [HOME, "nope", "nope", "nope"]));
  try {
    await h.start();
    await reaches(clock, () => h.action.requests.length === 1);
    await h.night();
    if (errorFirst) workAnswer(); else eventAnswer();
    await flush();
    assert.equal(work.badReplies, 1, "a pending decision fences the error too");
    if (errorFirst) eventAnswer(); else workAnswer();
    await reaches(clock, () => h.runtime.submitted.some((call) => call.tool === "navigate"));
    assert.ok(h.stack.includes(work));
    assert.equal(work.badReplies, 1);
    assert.equal(work.taken, before.taken);
    assert.deepEqual(work.failing, before.failing);
    assert.equal(h.events.some((event) => event.kind === "objective" && event.event === "finished"), false);
    assert.equal(h.chat.requests.length, 0);
  } finally { await h.stop(); }
});

test("an unusable reply on still-current work counts and ends the order as before", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const h = setup(clock);
  const work = ordinary(h, "Bob");
  work.badReplies = 1;
  h.runtime.snapshot = { ...h.runtime.snapshot, health: 7 };
  h.action.reply(CARRY, "nope", "nope", "nope");
  h.chat.reply({ say: "I cannot work it out." });
  try {
    await h.start();
    await reaches(clock, () => !h.stack.includes(work));
    assert.equal(work.badReplies, 2);
    assert.ok(h.events.some((event) => event.kind === "objective" && event.event === "finished" && event.outcome === "failed"));
  } finally { await h.stop(); }
});

test("held situation status read does not delay reading and applying a player stop", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const h = setup(clock, { noGain: { minutes: 5, sampleMs: 30_000 } });
  ordinary(h, "Bob");
  h.action.reply(FETCH, CARRY);
  h.chat.reply({ say: "Stopping.", route: "stop", request: "" });
  let release = () => {};
  try {
    await h.start();
    await reaches(clock, () => h.runtime.submitted.some((call) => call.tool === "collect_block"));
    h.runtime.snapshot = { ...h.runtime.snapshot, clock: { timeOfDay: 12_100, phase: "day", minutesUntilChange: 1, sleeping: false } };
    const held = h.runtime.holdNextStatus();
    release = held.release;
    await clock.settle(held.started, 20_000);
    h.runtime.inbox.push(say("Bob", "Ayla, stop"));
    await reaches(clock, () => h.agent.activity === "idle");
    release();
    await flush();
    assert.deepEqual(h.situations(), [], "the read from before stop is invalidated");
  } finally { release(); await h.stop(); }
});

test("a second event while a decision is in flight waits behind it; the same kind is dropped", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const h = setup(clock);
  ordinary(h);
  h.hold()();
  const first = h.hold();
  h.action.reply(FETCH, CARRY, CARRY);
  try {
    await h.start();
    await reaches(clock, () => h.runtime.submitted.some((call) => call.tool === "collect_block"));
    await h.sample({ health: 7 });
    assert.equal(h.action.requests.length, 2);
    await h.night();
    await h.sample({ health: 3 });
    assert.equal(h.action.requests.length, 2, "only one decision in flight");
    first();
    await reaches(clock, () => h.situations().filter((event) => event.event === "decided").length === 2);
    assert.deepEqual(h.situations().filter((event) => event.event === "raised").map((event) => event.situation), ["low_health", "night"]);
    assert.equal(h.action.requests.length, 3);
  } finally { await h.stop(); }
});

test("the model away at the event: the decision retries, the step keeps running", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const h = setup(clock);
  const work = ordinary(h);
  h.action.reply(FETCH, CARRY);
  try {
    await h.start();
    await reaches(clock, () => h.runtime.submitted.some((call) => call.tool === "collect_block"));
    h.action.unavailable(2);
    await h.night();
    await reaches(clock, () => h.situations().some((event) => event.answer === "carried on"));
    assert.equal(h.action.requests.length, 4);
    assert.equal(work.running?.controller.signal.aborted, false);
    assert.deepEqual(h.runtime.cancelled, []);
  } finally { await h.stop(); }
});

test("situation decisions are not paced; an idle goal-less bot's first death after startup raises respawn", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const h = setup(clock, { persona: testPersona({ settings: { ...testPersona().settings, goalCallsPerMinute: 1 } }) });
  h.action.reply(HOME, CARRY);
  try {
    await h.start();
    h.runtime.die("Zombie");
    await h.sample({});
    await reaches(clock, () => h.situations().some((event) => event.situation === "respawn" && event.event === "decided"));
    await reaches(clock, () => h.runtime.submitted.some((call) => call.tool === "navigate"));
    const before = clock.now();
    await h.sample({ health: 7 });
    await reaches(clock, () => h.situations().some((event) => event.situation === "low_health" && event.event === "decided"));
    assert.ok(clock.now() - before < 1_000, "no goal pacing for either event");
    assert.equal(h.planner.requests.length, 0);
  } finally { await h.stop(); }
});

test("poll reads nothing while samples come", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const h = setup(clock);
  ordinary(h);
  h.action.reply(FETCH, CARRY);
  let reads = 0;
  const status = h.runtime.status.bind(h.runtime);
  h.runtime.status = () => { reads++; return status(); };
  try {
    await h.start();
    await reaches(clock, () => h.runtime.submitted.some((call) => call.tool === "collect_block"));
    const before = reads;
    h.runtime.snapshot = { ...h.runtime.snapshot, clock: { timeOfDay: 12_100, phase: "day", minutesUntilChange: 1, sleeping: false } };
    await clock.advance(20_000);
    assert.equal(reads - before, 200, "only the 100 ms gain samples, no extra status polls");
    assert.equal(h.situations().filter((event) => event.event === "raised").length, 1, "the samples reach the event watch");
  } finally { await h.stop(); }
});

test("a situation's planned step does not wait for an ordinary goal's spent budget", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const h = setup(clock, { persona: testPersona({ settings: { ...testPersona().settings, goalCallsPerMinute: 1 } }) });
  ordinary(h);
  h.runtime.durations.collect_block = 0;
  h.action.reply(FETCH, HOME);
  try {
    await h.start();
    await reaches(clock, () => h.events.some((event) => event.kind === "step"));
    await h.night();
    const answered = clock.now();
    await reaches(clock, () => h.runtime.submitted.some((call) => call.tool === "navigate"));
    assert.ok(clock.now() - answered < 1_000);
  } finally { await h.stop(); }
});

for (const eventFirst of [false, true]) test(`a goal error ${eventFirst ? "after" : "before"} a held situation answer is dropped without a work loop error`, async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const h = setup(clock, { persona: testPersona({ goal: "make a home" }) });
  const goalAnswer = h.planner.hold();
  const eventAnswer = h.hold();
  h.planner.reply("nope", "nope", "nope");
  h.action.reply(HOME);
  try {
    await h.start();
    await reaches(clock, () => h.planner.requests.length === 1);
    await h.night();
    if (eventFirst) eventAnswer(); else goalAnswer();
    await flush();
    assert.equal(h.logs.some((line) => line.includes("work loop error")), false);
    if (eventFirst) goalAnswer(); else eventAnswer();
    await reaches(clock, () => h.runtime.submitted.some((call) => call.tool === "navigate"));
    assert.equal(h.logs.some((line) => line.includes("work loop error")), false);
  } finally { goalAnswer(); await h.stop(); }
});

for (const requester of [null, "Bob"]) for (const nested of [false, true]) test(`the decision prompt holds the event and weighs boldness, gear and ${requester ?? "own goal"}${nested ? " under a night walk" : ""}`, async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const h = setup(clock, { persona: testPersona({ boldness: "cautious" }) });
  const work = ordinary(h, requester);
  if (nested) h.stack.push(newWork({ text: "night walk", requester: null, purpose: null }, null, { info: { kind: "night", cause: "night", raisedAt: 0 }, order: requester === null ? null : work, told: false }, { kind: "step", thought: "", step: HOME.step }));
  h.action.reply(...(nested ? [CARRY] : [FETCH, CARRY]));
  try {
    await h.start();
    await reaches(clock, () => h.runtime.submitted.some((call) => call.tool === (nested ? "navigate" : "collect_block")));
    if (nested) await h.sample({ health: 7 }); else await h.night();
    const prompt = h.action.requests.at(-1)?.at(-1)?.content ?? "";
    assert.match(prompt, nested ? /Running now: go to 100 64 0/u : /- Event: Night has just fallen/u);
    const whose = requester === null ? "your own goal" : "order from Bob";
    assert.ok(prompt.includes(`- Weigh: boldness cautious (cautious, steady or bold); gear: armour 0 points, bare hands; ${whose}`));
    assert.deepEqual(h.situations().find((event) => event.event === "raised")?.weigh, ["boldness cautious (cautious, steady or bold)", "gear: armour 0 points, bare hands", whose]);
  } finally { await h.stop(); }
});
