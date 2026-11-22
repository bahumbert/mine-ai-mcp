// Exercise sign scenario control flow against a bounded test context.
import assert from "node:assert/strict";
import test from "node:test";
import { scenarioDefinitionSchema } from "mine-labs";
import { Vec3 } from "vec3";
import { createFakeBot, createFakeClock, listenersAddedSince } from "../../../src/test-support/fake-bot/index.ts";
import { arenaFrame } from "../arena/frame.ts";
import { scenarioTestContext } from "../scenario-test-context.ts";
import { DRIVER_CLOCK_STOPPED_MS } from "./server-ticks.ts";
import { run } from "./signs.ts";

function setup(steps: unknown[], call: Parameters<typeof scenarioTestContext>[0]["call"]) {
  return scenarioTestContext({ scenario: scenarioDefinitionSchema.parse({ params: { steps }, goal: { kind: "completion" } }), call });
}
const answer = (action: string, result: Record<string, unknown>) => ({ action, durationMs: 0, result, summary: action }) as never;

/** Counts the reads of a bot's `time` getter: every poll of the world age reads it, so a poll still running reads it again. */
function countTimeReads(bot: object): () => number {
  const read = Object.getOwnPropertyDescriptor(bot, "time")?.get;
  let reads = 0;
  Object.defineProperty(bot, "time", { configurable: true, get() { reads += 1; return read?.call(bot); } });
  return () => reads;
}

test("firstReady selects the first craftable family member", async () => {
  const asked: string[] = [];
  const context = setup([{ call: "view_item_family", input: {}, save: "family" },
    { firstReady: "$family.members", save: "item" }, { call: "craft_item", input: { item: "$item" } }], async (action, input) => {
    if (action === "view_item_family") return answer(action, { status: "succeeded", members: ["a", "b", "c"] });
    if (action === "view_crafting_requirements") {
      const item = (input.items as { item_name: string }[])[0]!.item_name;
      asked.push(item);
      return answer(action, { status: "succeeded", requirements: { plan: { status: item === "b" ? "ready" : "uncraftable" } } });
    }
    assert.equal(input.item, "b");
    return answer(action, { status: "succeeded" });
  });
  assert.equal((await run(context)).status, "succeeded");
  assert.deepEqual(asked, ["a", "b"]);
});

test("errorContains accepts only the requested refusal", async () => {
  const steps = [{ call: "place_sign", input: {}, expect: { status: "failed", errorContains: "CELL_TAKEN" } }];
  const yes = setup(steps, async (action) => answer(action, { status: "failed", error: "CELL_TAKEN" }));
  const no = setup(steps, async (action) => answer(action, { status: "failed", error: "NO_EDITOR" }));
  assert.equal((await run(yes)).status, "succeeded");
  assert.equal((await run(no)).status, "failed");
});

test("alternative outcomes accept a successful resume or the named refusal", async () => {
  const steps = [{ call: "place_sign", input: {}, expect: { anyOf: [{ status: "succeeded" }, { status: "failed", errorContains: "CELL_TAKEN" }] } }];
  const context = setup(steps, async (action) => answer(action, { status: "failed", error: "CELL_TAKEN" }));
  assert.equal((await run(context)).status, "succeeded");
});

test("signLines checks the observed front and back at the lane cell", async () => {
  const steps = [{ check: "signLines", at: { x: 1, y: -60, z: 2 }, front: ["Actor", "", "", ""], back: ["", "", "", ""] }];
  const context = setup(steps, async (action, input) => {
    assert.deepEqual(input, { x: 65, y: -60, z: 514 });
    return answer(action, { status: "succeeded", signs: [{ known: true, front: ["Actor", "", "", ""], back: ["", "", "", ""] }] });
  });
  assert.equal((await run({ ...context, arena: arenaFrame({ x: 64, z: 512 }) })).status, "succeeded");
});

test("signPresent refuses a read with no sign", async () => {
  const steps = [{ call: "read_signs", input: { x: 1, y: -60, z: 1 } }, { check: "signPresent" }];
  const context = setup(steps, async (action) => answer(action, { status: "succeeded", signs: [] }));
  assert.equal((await run(context)).status, "failed");
  const present = setup(steps, async (action) => answer(action, { status: "succeeded", signs: [{ known: true }] }));
  assert.equal((await run(present)).status, "succeeded");
});

test("signAbsent accepts only an empty successful cell reading", async () => {
  const steps = [{ call: "read_signs", input: {} }, { check: "signAbsent" }];
  const empty = setup(steps, async (action) => answer(action, { status: "succeeded", signs: [] }));
  const present = setup(steps, async (action) => answer(action, { status: "succeeded", signs: [{ known: true }] }));
  assert.equal((await run(empty)).status, "succeeded");
  assert.equal((await run(present)).status, "failed");
});

test("signState rejects text other than the blank or requested lines", async () => {
  const steps = [{ call: "read_signs", input: {} }, { check: "signState", frontAny: [["", "", "", ""], ["Actor", "hello", "", ""]] }];
  const context = setup(steps, async (action) => answer(action, { status: "succeeded", signs: [{ known: true, front: ["other", "", "", ""], back: ["", "", "", ""] }] }));
  assert.equal((await run(context)).status, "failed");
  const blank = setup(steps, async (action) => answer(action, { status: "succeeded", signs: [{ known: true, front: ["", "", "", ""], back: ["", "", "", ""] }] }));
  assert.equal((await run(blank)).status, "succeeded");
});

for (const ticksPerSecond of [20, 10]) test(`server ticks settle before the next read at ${ticksPerSecond} TPS`, async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const harness = createFakeBot({ clock, server: { ticksPerSecond } });
  const startAge = harness.bot.time.age;
  const context = setup([{ waitServerTicks: 40 }, { call: "read_signs", input: {} }], async (action) => answer(action, { status: "succeeded" }));
  const outcome = await clock.settle(run({ ...context, bot: harness.bot }), 20_000);
  assert.equal(outcome.status, "succeeded");
  assert.ok(harness.bot.time.age - startAge >= 40, `server age moved ${harness.bot.time.age - startAge}, expected at least 40`);
});

test("a stopped server ends the server-tick step before the next read", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const harness = createFakeBot({ clock });
  harness.server.stop();
  const calls: string[] = [];
  const context = setup([{ waitServerTicks: 40 }, { call: "read_signs", input: {} }], async (action) => {
    calls.push(action);
    return answer(action, { status: "succeeded" });
  });
  const startAge = harness.bot.time.age;
  const outcome = await clock.settle(run({ ...context, bot: harness.bot }), 40_000);
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.detail, "Server clock stalled");
  assert.equal(harness.bot.time.age, startAge);
  assert.deepEqual(calls, []);
});

for (const ticksPerSecond of [20, 10]) test(`an unsent cancellation uses server time at ${ticksPerSecond} TPS and cannot pass`, async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const harness = createFakeBot({ clock, server: { ticksPerSecond } });
  let cancelledAtAge = 0;
  const startAge = harness.bot.time.age;
  let cancel!: () => void;
  const cancelled = new Promise<void>((done) => { cancel = done; });
  const calls: string[] = [];
  const context = setup([{ cancel: "place_sign", input: { x: 1, y: -60, z: 2 } }, { call: "navigate", input: {} }], async (action) => {
    calls.push(action);
    if (action === "place_sign") { await cancelled; return answer(action, { status: "cancelled", error: "cancelled" }); }
    if (action === "cancel_foreground_action") { cancelledAtAge = harness.bot.time.age; cancel(); }
    return answer(action, { status: "succeeded" });
  });
  const outcome = await clock.settle(run({ ...context, bot: harness.bot }), 10_000);
  assert.equal(outcome.status, "failed");
  assert.deepEqual(calls, ["place_sign", "cancel_foreground_action"]);
  assert.ok(cancelledAtAge - startAge >= 40, `server age at fallback: ${cancelledAtAge}, start: ${startAge}`);
});

test("a stopped server ends the unsent cancellation with a bounded failure", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const harness = createFakeBot({ clock });
  harness.server.stop();
  let finish!: () => void;
  const cancelled = new Promise<void>((done) => { finish = done; });
  const context = setup([{ cancel: "place_sign", input: { x: 1, y: -60, z: 1 } }], async (action) => {
    if (action === "place_sign") { await cancelled; return answer(action, { status: "cancelled", error: "cancelled" }); }
    finish();
    return answer(action, { status: "succeeded" });
  });
  const startAge = harness.bot.time.age;
  const outcome = await clock.settle(run({ ...context, bot: harness.bot }), 40_000);
  assert.equal(outcome.status, "failed");
  assert.equal(harness.bot.time.age, startAge);
  assert.match(outcome.detail ?? "", /Server clock stalled/u);
});

for (const ticksPerSecond of [20, 10]) test(`cancel follows the placement packet before the server-tick fallback at ${ticksPerSecond} TPS`, async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const harness = createFakeBot({ clock, server: { ticksPerSecond } });
  let cancel!: () => void;
  let cancelledAtAge = Number.NaN;
  const cancelled = new Promise<void>((done) => { cancel = done; });
  const context = setup([{ cancel: "place_sign", input: { x: 1, y: -60, z: 1 } }], async (action) => {
    if (action === "place_sign") {
      harness.bot._client.write("block_place", { location: new Vec3(1, -61, 1), direction: 1, hand: 0 } as never);
      await cancelled;
      return answer(action, { status: "cancelled", error: "cancelled" });
    }
    cancelledAtAge = harness.bot.time.age;
    cancel();
    return answer(action, { status: "succeeded" });
  });
  const original = harness.bot._client.write;
  const added = listenersAddedSince(harness.bot);
  const reads = countTimeReads(harness.bot);
  const startAge = harness.bot.time.age;
  const outcome = await clock.settle(run({ ...context, bot: harness.bot }), 10_000);
  const readsAtEnd = reads();
  assert.ok(cancelledAtAge - startAge < 5, `cancel reached at server age ${cancelledAtAge}, start ${startAge}: the fallback ran`);
  assert.equal(outcome.status, "succeeded");
  assert.equal(harness.bot._client.write, original);
  assert.equal(added("physicsTick"), 0);
  await clock.advance(31_000);
  assert.equal(reads(), readsAtEnd, "the world-age poll read the age after its wait ended");
  assert.equal(added("physicsTick"), 0);
});

test("an unrelated placement packet does not qualify as the sign send", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const harness = createFakeBot({ clock });
  let release!: () => void;
  const cancelled = new Promise<void>((done) => { release = done; });
  const context = setup([{ cancel: "place_sign", input: { x: 1, y: -60, z: 1 } }], async (action) => {
    if (action === "place_sign") {
      harness.bot._client.write("block_place", { location: new Vec3(99, -61, 99), direction: 1, hand: 0 } as never);
      await cancelled;
      return answer(action, { status: "cancelled", error: "cancelled" });
    }
    release();
    return answer(action, { status: "succeeded" });
  });
  const added = listenersAddedSince(harness.bot);
  assert.equal((await clock.settle(run({ ...context, bot: harness.bot }), 10_000)).status, "failed");
  assert.equal(added("physicsTick"), 0);
});

test("settlement and a throwing cancellation release the packet and tick observers", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();

  const early = createFakeBot({ clock });
  const earlyContext = setup([{ cancel: "place_sign", input: { x: 1, y: -60, z: 1 } }], async (action) => answer(action, { status: "succeeded" }));
  const earlyAdded = listenersAddedSince(early.bot);
  const earlyWrite = early.bot._client.write;
  const earlyReads = countTimeReads(early.bot);
  assert.equal((await clock.settle(run({ ...earlyContext, bot: early.bot }), 10_000)).status, "failed");
  const earlyReadsAtSettle = earlyReads();
  await clock.advance(DRIVER_CLOCK_STOPPED_MS + 1);
  assert.equal(earlyReads(), earlyReadsAtSettle, "the world-age poll read the age after the settled cancellation");
  assert.equal(early.bot._client.write, earlyWrite);
  assert.equal(earlyAdded("physicsTick"), 0);

  const throwing = createFakeBot({ clock });
  const throwingContext = setup([{ cancel: "place_sign", input: { x: 1, y: -60, z: 1 } }], async (action) => {
    if (action === "place_sign") {
      throwing.bot._client.write("block_place", { location: new Vec3(1, -61, 1), direction: 1, hand: 0 } as never);
      return await new Promise<never>(() => {});
    }
    throw new Error("cancel failed");
  });
  const added = listenersAddedSince(throwing.bot);
  const write = throwing.bot._client.write;
  const throwingReads = countTimeReads(throwing.bot);
  await assert.rejects(clock.settle(run({ ...throwingContext, bot: throwing.bot }), 10_000), /cancel failed/u);
  const throwingReadsAtSettle = throwingReads();
  await clock.advance(DRIVER_CLOCK_STOPPED_MS + 1);
  assert.equal(throwingReads(), throwingReadsAtSettle, "the world-age poll read the age after the rejected cancellation");
  assert.equal(throwing.bot._client.write, write);
  assert.equal(added("physicsTick"), 0);
});

test("saved results feed a later call in the lane and confirmed is required", async () => {
  const calls: { action: string; input: Record<string, unknown> }[] = [];
  const context = scenarioTestContext({
    scenario: scenarioDefinitionSchema.parse({ params: { steps: [
      { call: "view_item_family", input: { family: "sign" }, save: "family" },
      { call: "place_sign", input: { x: 1, y: -60, z: 2, sign_item: "$family.members.0" } },
      { check: "confirmed" },
    ] }, goal: { kind: "completion" } }),
    arena: arenaFrame({ x: 64, z: 512 }),
    call: async (action, input) => {
      calls.push({ action, input });
      const result = action === "view_item_family" ? { status: "succeeded", members: ["fixture"] } : { status: "succeeded", sign: { confirmed: true } };
      return { action, durationMs: 0, result, summary: action } as never;
    },
  });
  assert.equal((await run(context)).status, "succeeded");
  assert.deepEqual(calls[1]?.input, { x: 65, y: -60, z: 514, sign_item: "fixture" });
});

test("an unconfirmed placement fails the confirmation check", async () => {
  const context = scenarioTestContext({
    scenario: scenarioDefinitionSchema.parse({ params: { steps: [
      { call: "place_sign", input: {} }, { check: "confirmed" },
    ] }, goal: { kind: "completion" } }),
    call: async (action) => ({ action, durationMs: 0, result: { status: "succeeded", sign: { confirmed: false } }, summary: action }) as never,
  });
  assert.equal((await run(context)).status, "failed");
});
