// Concurrent situation decisions and the work loop's fences around their answers.
import assert from "node:assert/strict";
import test from "node:test";
import { createFakeClock, flush } from "../../../src/test-support/fake-bot/fake-clock.ts";
import { describeStep, stepKey } from "../actions.ts";
import { testPersona } from "../testing.ts";
import { say } from "./agent-fixtures.test.ts";
import { CARRY, FETCH, HOME, ordinary, reaches, setup } from "./situation-fixtures.test.ts";
import { newWork } from "./work.ts";

for (const ending of ["dawn", "stop", "death"] as const) test(`${ending} drops a held decision at once and tells its captured requester once`, async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const h = setup(clock);
  ordinary(h, "Bob");
  h.hold()();
  const answer = h.hold();
  h.action.reply(FETCH);
  h.chat.reply({ say: "The event ended." });
  try {
    await h.start();
    await reaches(clock, () => h.runtime.submitted.some((call) => call.tool === "collect_block"));
    if (ending === "death") await h.sample({ health: 7 }); else await h.night();
    assert.equal(h.action.requests.length, 2);
    if (ending === "dawn") await h.sample({ clock: { timeOfDay: 23_459, phase: "day", minutesUntilChange: 13_083 / 1_200, sleeping: false } });
    if (ending === "death") await h.sample({ health: 0 });
    if (ending === "stop") h.agent["stopWorkOf"]("Bob");
    await clock.settle(h.agent["situations"].settled(), 500);
    await reaches(clock, () => h.chat.requests.length === 1);
    assert.equal(h.situations().filter((event) => event.event === "ended").length, 1);
    assert.equal(h.situations().at(-1)?.detail, ending === "dawn" ? "day came" : ending === "death" ? "died" : "stopped by Bob");
    const notification = h.chat.requests[0]?.at(-1)?.content ?? "";
    assert.doesNotMatch(notification, /You are working on|Now you start/u, "event endings never claim the stopped order is active or starting a phase");
    assert.doesNotMatch(notification, /reply with an empty say/u, "the captured requester must hear the event");
    assert.ok(notification.includes(ending === "dawn" ? "day came" : ending === "death" ? "died" : "stopped by Bob"));
    h.action.reply(HOME);
    answer();
    await flush();
    assert.equal(h.runtime.submitted.some((call) => call.tool === "navigate"), false, "the detached answer submits nothing");
    assert.equal(h.chat.requests.length, 1);
  } finally { await h.stop(); }
});

for (const reply of ["done", "give_up", "limit"] as const) test(`model ${reply} closes the situation once, keeps later context and resumes work`, async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const h = setup(clock);
  const work = ordinary(h);
  h.runtime.durations.navigate = 100;
  h.runtime.walkOnNavigate = true;
  h.action.reply(FETCH, HOME, reply === "give_up" ? { give_up: "home" } : reply === "done" ? { done: "home" } : { step: { ...HOME.step, x: 200 } }, FETCH);
  try {
    await h.start();
    await reaches(clock, () => h.runtime.submitted.some((call) => call.tool === "collect_block"));
    await h.night();
    await reaches(clock, () => h.stack.at(-1)?.situation !== null && h.runtime.submitted.some((call) => call.tool === "navigate"));
    const event = h.stack.at(-1)!;
    if (reply === "limit") event.taken = h.agent["options"].persona.settings.maxStepsPerObjective;
    await reaches(clock, () => h.runtime.submitted.filter((call) => call.tool === "collect_block").length === 2);
    const prompt = h.action.requests[2]?.at(-1)?.content ?? "";
    assert.match(prompt, /leave this event/u);
    assert.match(prompt, /Set aside: "get 2 oak logs"/u);
    assert.match(prompt, /Weigh: boldness steady/u);
    assert.doesNotMatch(prompt, /"skill":"wait"/u);
    assert.deepEqual(h.stack, [work]);
    assert.equal(h.situations().filter((entry) => entry.event === "ended").length, 1);
    h.agent["situations"].closed(event, "duplicate close");
    assert.equal(h.situations().filter((entry) => entry.event === "ended").length, 1);
  } finally { await h.stop(); }
});

for (const underOrder of [false, true]) test(`dawn ends the night situation ${underOrder ? "under an order" : "at home during craft"} and resumes the set-aside work`, async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const h = setup(clock);
  const work = ordinary(h);
  h.runtime.durations.navigate = 0;
  h.runtime.durations.craft_item = 100_000;
  h.action.reply(FETCH, HOME, { step: { skill: "craft_item", item: "stick", count: 4 } }, ...(underOrder ? [HOME, CARRY] : []), FETCH);
  try {
    await h.start();
    await reaches(clock, () => h.runtime.submitted.some((call) => call.tool === "collect_block"));
    await h.night();
    await reaches(clock, () => h.runtime.submitted.some((call) => call.tool === "craft_item"));
    const event = h.stack.at(-1)!;
    if (underOrder) {
      h.runtime.durations.navigate = 100;
      h.agent["take"]({ text: "walk for Alice", requester: "Alice", purpose: null });
      await reaches(clock, () => h.stack.at(-1)?.running?.step.skill === "go_to");
    }
    h.runtime.durations.collect_block = 0;
    await h.sample({ clock: { timeOfDay: 23_459, phase: "day", minutesUntilChange: 13_083 / 1_200, sleeping: false } });
    await reaches(clock, () => !h.stack.includes(event));
    assert.equal(h.situations().filter((entry) => entry.event === "ended" && entry.detail === "day came").length, 1);
    await reaches(clock, () => work.steps.some((step) => step.outcome === "done"));
  } finally { await h.stop(); }
});

test("dawn while dig_shelter climbs out does not cut it", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const h = setup(clock);
  ordinary(h);
  const controller = new AbortController();
  const event = newWork({ text: "night", requester: null, purpose: null }, null, { info: { kind: "night", cause: "Night", raisedAt: 0 }, order: null, told: true });
  event.running = { step: { skill: "dig_shelter" }, controller };
  h.stack.push(event);
  h.agent["situations"].end("night", "day came", h.runtime.snapshot);
  await flush();
  assert.equal(controller.signal.aborted, false);
  assert.ok(h.stack.includes(event));
  event.running = null;
  await h.agent["situations"].settled();
  assert.equal(h.stack.includes(event), false);
  assert.equal(h.situations().at(-1)?.detail, "day came");
});

for (const whispered of [false, true]) test(`a new ${whispered ? "whispered " : ""}order during a held event keeps running when the old answer returns`, async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const h = setup(clock);
  ordinary(h, "Bob");
  h.hold()();
  const answer = h.hold();
  h.action.reply(FETCH);
  h.chat.reply({ say: "The work changed." });
  try {
    await h.start();
    await reaches(clock, () => h.runtime.submitted.some((call) => call.tool === "collect_block"));
    await h.night();
    h.agent["take"]({ text: "new walk", requester: "Alice", purpose: null }, whispered ? "Alice" : null);
    h.action.reply(HOME, FETCH);
    answer();
    await reaches(clock, () => h.stack.at(-1)?.running !== null && h.stack.at(-1)?.objective.requester === "Alice");
    assert.equal(h.situations().at(-1)?.detail, "the work changed");
    assert.equal(h.stack.some((entry) => entry.situation !== null), false);
    assert.equal(h.stack.at(-1)?.running?.controller.signal.aborted, false);
    assert.equal(h.chat.requests.length, 1);
  } finally { await h.stop(); }
});

test("one order hears each of two event decisions once, including a whispered answer", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const h = setup(clock);
  ordinary(h, "Bob").whisperTo = "Bob";
  h.action.reply(FETCH, CARRY, CARRY);
  h.chat.reply({ say: "Night choice." }, { say: "Health choice." });
  try {
    await h.start();
    await reaches(clock, () => h.runtime.submitted.some((call) => call.tool === "collect_block"));
    await h.night();
    await h.sample({ health: 7 });
    await reaches(clock, () => h.runtime.said.length === 2);
    assert.equal(h.chat.requests.length, 2);
    assert.ok(h.runtime.submitted.filter((call) => call.tool === "send_message").every((call) => call.input.to === "Bob"));
    await h.sample({});
    assert.equal(h.chat.requests.length, 2);
  } finally { await h.stop(); }
});

test("low health on top of night closes after its step recovers and night goes on", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const h = setup(clock);
  ordinary(h);
  h.action.reply(FETCH, HOME, HOME, HOME);
  try {
    await h.start();
    await reaches(clock, () => h.runtime.submitted.some((call) => call.tool === "collect_block"));
    await h.night();
    await reaches(clock, () => h.stack.at(-1)?.running?.step.skill === "go_to");
    h.runtime.durations.navigate = 100;
    await h.sample({ health: 7 });
    await reaches(clock, () => h.stack.at(-1)?.situation?.info.kind === "low_health" && h.stack.at(-1)?.running !== null);
    const low = h.stack.at(-1)!;
    await h.sample({ health: 20 });
    assert.equal(low.running?.controller.signal.aborted, false, "recovery never cuts the running step");
    assert.ok(h.stack.includes(low));
    await reaches(clock, () => !h.stack.includes(low));
    await reaches(clock, () => h.stack.at(-1)?.situation?.info.kind === "night");
    assert.equal(h.situations().filter((entry) => entry.event === "ended" && entry.situation === "low_health").length, 1);
  } finally { await h.stop(); }
});

for (const held of [false, true]) test(`a second death ends ${held ? "a held respawn decision before respawn" : "the running respawn situation"}`, async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const h = setup(clock);
  const release = held ? h.hold() : () => {};
  if (!held) h.action.reply(HOME);
  try {
    await h.start();
    h.runtime.die("Zombie");
    await h.sample({});
    await reaches(clock, () => held ? h.action.requests.length === 1 : h.runtime.submitted.some((call) => call.tool === "navigate"));
    await h.sample({ health: 0 });
    await clock.settle(h.agent["situations"].settled(), 500);
    if (!held) await reaches(clock, () => h.situations().some((entry) => entry.event === "ended"));
    assert.equal(h.situations().filter((entry) => entry.event === "ended").length, 1);
    h.runtime.die("Skeleton");
    h.action.reply(CARRY);
    await h.sample({ health: 20 });
    await reaches(clock, () => h.situations().filter((entry) => entry.event === "raised" && entry.situation === "respawn").length === 2);
    assert.equal(h.action.requests.length, 2);
    if (held) {
      await clock.settle(h.agent["situations"].settled(), 500);
      h.action.reply(HOME);
      release();
      await flush();
      assert.equal(h.runtime.submitted.some((call) => call.tool === "navigate"), false, "the old respawn answer cannot submit go_to");
    }
  } finally { await h.stop(); }
});

test("a respawn detaches a held night decision before raising its decision", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const h = setup(clock);
  ordinary(h);
  h.hold()();
  h.hold();
  h.action.reply(FETCH);
  try {
    await h.start();
    await reaches(clock, () => h.runtime.submitted.some((call) => call.tool === "collect_block"));
    await h.night();
    h.runtime.die("Zombie");
    h.action.reply(CARRY);
    await h.sample({});
    await reaches(clock, () => h.situations().some((entry) => entry.event === "decided" && entry.situation === "respawn"));
    assert.ok(h.situations().some((entry) => entry.event === "ended" && entry.situation === "night" && entry.detail === "died"));
  } finally { await h.stop(); }
});

test("later respawn call after recovery expiry removes go back and refreshes age", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const h = setup(clock);
  h.runtime.durations.navigate = 100;
  h.action.reply(HOME, CARRY);
  try {
    await h.start();
    h.runtime.die("Zombie");
    h.runtime.snapshot = { ...h.runtime.snapshot, lastDeath: { ...h.runtime.snapshot.lastDeath!, minutesAgo: 2 } };
    await h.sample({});
    await reaches(clock, () => h.runtime.submitted.some((call) => call.tool === "navigate"));
    assert.match(h.action.requests[0]?.at(-1)?.content ?? "", /go back for your things/u);
    h.runtime.snapshot = { ...h.runtime.snapshot, lastDeath: { ...h.runtime.snapshot.lastDeath!, minutesAgo: 6 } };
    await reaches(clock, () => h.action.requests.length >= 2);
    const later = h.action.requests[1]?.at(-1)?.content ?? "";
    assert.doesNotMatch(later, /go back for your things/u);
    assert.match(later, /pick_up no longer takes them \(over 5 min\)/u);
    assert.match(later, /last death 6 min ago/u);
  } finally { await h.stop(); }
});

test("a player's stop ends pushed situations and decisions; the night stays handled", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const h = setup(clock);
  ordinary(h);
  h.action.reply(FETCH, HOME);
  try {
    await h.start();
    await reaches(clock, () => h.runtime.submitted.some((call) => call.tool === "collect_block"));
    await h.night();
    await reaches(clock, () => h.stack.at(-1)?.running?.step.skill === "go_to");
    h.agent["stopWorkOf"]("Bob");
    await h.sample({});
    assert.equal(h.stack.length, 0);
    assert.equal(h.situations().filter((entry) => entry.event === "ended").length, 1);
    assert.equal(h.situations().filter((entry) => entry.event === "raised").length, 1);
  } finally { await h.stop(); }
});

test("stop while a cover read is held raises nothing after release", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const h = setup(clock);
  ordinary(h);
  h.action.reply(FETCH);
  let release!: () => void;
  const held = new Promise<boolean>((resolve) => { release = () => resolve(false); });
  const decisions = h.agent["situations"];
  const cover = decisions.underCover.bind(decisions);
  let reading = false;
  decisions.underCover = () => { reading = true; return held; };
  try {
    await h.start();
    await reaches(clock, () => h.runtime.submitted.some((call) => call.tool === "collect_block"));
    await h.night();
    await reaches(clock, () => reading);
    h.agent["stopWorkOf"]("Bob");
    release();
    await flush();
    assert.equal(h.situations().length, 0);
    assert.equal(h.action.requests.length, 1);
  } finally { release(); decisions.underCover = cover; await h.stop(); }
});

test("an order above a pushed situation completes then resumes it", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const h = setup(clock);
  ordinary(h);
  h.action.reply(FETCH, HOME, { step: { ...HOME.step, x: 200 } }, CARRY, { step: { ...HOME.step, x: 300 } });
  try {
    await h.start();
    await reaches(clock, () => h.runtime.submitted.some((call) => call.tool === "collect_block"));
    await h.night();
    await reaches(clock, () => h.runtime.submitted.some((call) => call.tool === "navigate"));
    const event = h.stack.at(-1)!;
    h.runtime.durations.navigate = 10;
    h.agent["take"]({ text: "new order", requester: "Alice", purpose: null });
    await reaches(clock, () => h.runtime.submitted.some((call) => call.input.x === 300));
    assert.equal(h.stack.at(-1), event);
    assert.equal(h.situations().filter((entry) => entry.event === "ended").length, 0);
  } finally { await h.stop(); }
});

test("dawn drops an idle held decision and the next order finishes", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const h = setup(clock);
  h.hold();
  h.runtime.durations.navigate = 0;
  try {
    await h.start();
    await h.night();
    await reaches(clock, () => h.action.requests.length === 1);
    await h.sample({ clock: { timeOfDay: 23_459, phase: "day", minutesUntilChange: 13_083 / 1_200, sleeping: false } });
    await clock.settle(h.agent["situations"].settled(), 500);
    h.action.reply(HOME, CARRY);
    h.agent["take"]({ text: "walk", requester: "Alice", purpose: null });
    await reaches(clock, () => h.events.some((event) => event.kind === "step" && event.outcome === "done"));
    assert.equal(h.situations().filter((event) => event.event === "ended").length, 1);
  } finally { await h.stop(); }
});

test("a stale fallback status answer cannot detach the new life's held respawn decision", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const h = setup(clock);
  const decisions = h.agent["situations"];
  h.runtime.die("Zombie");
  decisions.observe(h.runtime.snapshot);
  await flush();
  const held = h.runtime.holdNextStatus();
  const read = decisions.status();
  await clock.settle(held.started, 500);
  h.hold();
  try {
    h.runtime.die("Skeleton");
    decisions.observe(h.runtime.snapshot);
    await reaches(clock, () => h.action.requests.length === 1);
    held.release();
    await read;
    await flush();
    assert.equal(h.situations().filter((event) => event.event === "ended").length, 0);
  } finally { held.release(); decisions.stopFor(null); await h.stop(); }
});

const UNSAFE = [
  ["in a boat", { vehicle: { id: 12, name: "oak_boat" } }],
  ["while swimming", { footing: { onGround: true, inWater: true, inLava: false } }],
  ["in lava", { footing: { onGround: true, inWater: false, inLava: true } }],
  ["mid-fall", { footing: { onGround: false, inWater: false, inLava: false } }],
  ["with unknown footing", { footing: undefined }],
  ["with unknown footing and a known vehicle", { footing: undefined, vehicle: { id: 12, name: "oak_boat" } }],
  ["while asleep", { clock: { timeOfDay: 13_000, phase: "night", minutesUntilChange: 10_459 / 1_200, sleeping: true } }],
] as const;

for (const [where, change] of UNSAFE) test(`an answer ${where} waits for a fresh land read`, async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const h = setup(clock);
  const work = ordinary(h);
  h.hold()();
  const answer = h.hold();
  h.action.reply(FETCH, HOME);
  try {
    await h.start();
    await reaches(clock, () => work.running !== null);
    await h.night();
    // The raising sample was on land; only the answer's new read sees the hazard.
    h.runtime.snapshot = { ...h.runtime.snapshot, ...change };
    answer();
    await reaches(clock, () => h.stack.length === 2);
    await flush();
    assert.equal(work.running?.controller.signal.aborted, false, "a stale land sample cannot authorize a stop");
    assert.equal(h.runtime.submitted.some((call) => call.tool === "navigate"), false);
    await h.sample({ vehicle: null, footing: { onGround: true, inWater: false, inLava: false }, clock: { timeOfDay: 12_100, phase: "day", minutesUntilChange: 442 / 1_200, sleeping: false } });
    await reaches(clock, () => h.runtime.submitted.some((call) => call.tool === "navigate"));
    assert.equal(work.steps[0]?.outcome, "interrupted");
    assert.equal(h.runtime.cancelled.length, 1);
  } finally { await h.stop(); }
});

for (const skill of ["eat", "equip", "sleep", "dig_shelter"] as const) test(`an answer during ${skill} lets the step finish, even before sleeping metadata arrives`, async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const h = setup(clock);
  const work = ordinary(h);
  const controller = new AbortController();
  const step = skill === "equip" ? { skill, item: "iron_sword" } as const : skill === "eat" ? { skill, food: "bread" } as const : { skill };
  h.runtime.snapshot = { ...h.runtime.snapshot, clock: { timeOfDay: 12_100, phase: "day", minutesUntilChange: 442 / 1_200, sleeping: false } };
  work.running = { step, controller };
  h.action.reply(HOME);
  h.agent["situations"].raise({ kind: "night", cause: "Night", raisedAt: 0 }, h.runtime.snapshot);
  await clock.settle(h.agent["situations"].settled(), 20_000);
  assert.equal(controller.signal.aborted, false);
  work.running = null;
  await h.start();
  try {
    await reaches(clock, () => h.runtime.submitted.some((call) => call.tool === "navigate"));
    assert.equal(controller.signal.aborted, false, "the finished protected step's pending stop is gone");
  } finally { await h.stop(); }
});

test("a delayed safety read cannot stop a replacement step", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const h = setup(clock);
  const work = ordinary(h);
  h.runtime.snapshot = { ...h.runtime.snapshot, clock: { timeOfDay: 12_100, phase: "day", minutesUntilChange: 442 / 1_200, sleeping: false } };
  const old = new AbortController();
  work.running = { step: FETCH.step, controller: old };
  const held = h.runtime.holdNextStatus();
  h.action.reply(HOME);
  try {
    h.agent["situations"].raise({ kind: "night", cause: "Night", raisedAt: 0 }, h.runtime.snapshot);
    await clock.settle(held.started, 20_000);
    const replacement = new AbortController();
    work.running = { step: FETCH.step, controller: replacement };
    held.release();
    await flush();
    h.agent["situations"].observe(h.runtime.snapshot);
    await flush();
    assert.equal(old.signal.aborted, false);
    assert.equal(replacement.signal.aborted, false);
  } finally { held.release(); await h.stop(); }
});

for (const end of ["itself", "dawn", "stop", "death"] as const) test(`a pending stop is cleared when the step ends by ${end}`, async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const h = setup(clock);
  const work = ordinary(h);
  h.runtime.snapshot = { ...h.runtime.snapshot, footing: undefined };
  if (end === "itself" || end === "dawn") h.runtime.durations.collect_block = 100;
  h.action.reply(FETCH, HOME, HOME);
  try {
    await h.start();
    await reaches(clock, () => h.runtime.submitted.some((call) => call.tool === "collect_block"));
    await h.night();
    await reaches(clock, () => h.stack.length === 2);
    assert.equal(work.running?.controller.signal.aborted, false);
    const event = h.stack[1]!;
    if (end === "dawn") h.agent["situations"].end("night", "day came", h.runtime.snapshot);
    if (end === "stop") h.agent["stopAll"]();
    if (end === "death") h.runtime.die("Zombie");
    if (end === "itself" || end === "dawn") {
      // Complete the existing action through its fake-runtime answer, without interrupting the step.
      h.runtime.durations.navigate = 0;
      await reaches(clock, () => work.steps.length > 0);
      assert.equal(work.steps[0]?.outcome, "done");
    } else {
      work.step?.abort();
      await reaches(clock, () => work.steps.length > 0);
    }
    if (end === "dawn") assert.equal(h.stack.includes(event), false);
    if (end === "stop") h.stack.push(newWork({ text: "walk", requester: null, purpose: null }, null, null, { kind: "step", thought: "", step: HOME.step }));
    await h.sample({ footing: { onGround: true, inWater: false, inLava: false } });
    await reaches(clock, () => h.runtime.submitted.some((call) => call.tool === "navigate"));
    assert.equal(h.stack.at(-1)?.running?.controller.signal.aborted ?? false, false);
  } finally { await h.stop(); }
});

for (const ending of ["land", "dawn", "stop"] as const) test(`a failed fresh safety read retries on observe unless ${ending} ends it`, async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const h = setup(clock);
  const work = ordinary(h);
  h.runtime.snapshot = { ...h.runtime.snapshot, clock: { timeOfDay: 12_100, phase: "day", minutesUntilChange: 442 / 1_200, sleeping: false } };
  const controller = new AbortController();
  work.running = { step: FETCH.step, controller };
  const status = h.runtime.status.bind(h.runtime);
  let failed = false;
  h.runtime.status = () => { if (!failed) { failed = true; return Promise.reject(new Error("transport away")); } return status(); };
  h.action.reply(HOME);
  h.agent["situations"].raise({ kind: "night", cause: "Night", raisedAt: 0 }, h.runtime.snapshot);
  await clock.settle(h.agent["situations"].settled(), 20_000);
  await flush();
  assert.equal(controller.signal.aborted, false);
  if (ending === "dawn") h.agent["situations"].end("night", "day came", h.runtime.snapshot);
  if (ending === "stop") h.agent["situations"].stopFor("Bob");
  h.agent["situations"].observe(h.runtime.snapshot);
  await flush();
  assert.equal(controller.signal.aborted, ending === "land");
});

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
    await h.sample({ clock: { timeOfDay: 14_000, phase: "night", minutesUntilChange: 9_459 / 1_200, sleeping: false } });
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
    assert.equal(h.chat.requests.length, 1, "only the accepted situation decision narrates");
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
    h.runtime.snapshot = { ...h.runtime.snapshot, clock: { timeOfDay: 12_100, phase: "day", minutesUntilChange: 442 / 1_200, sleeping: false } };
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
    h.runtime.snapshot = { ...h.runtime.snapshot, clock: { timeOfDay: 12_100, phase: "day", minutesUntilChange: 442 / 1_200, sleeping: false } };
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
  if (nested) h.runtime.snapshot = { ...h.runtime.snapshot, clock: { timeOfDay: 12_100, phase: "day", minutesUntilChange: 442 / 1_200, sleeping: false } };
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
