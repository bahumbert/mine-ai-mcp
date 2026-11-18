// Sequence steps wait for authoritative server progress before calling the runtime.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { scenarioDefinitionSchema } from "mine-labs";
import { createFakeBot, createFakeClock, listenersAddedSince } from "../../../src/test-support/fake-bot/index.ts";
import { scenarioTestContext } from "../scenario-test-context.ts";
import type { ScenarioCall, ScenarioContext } from "../scenario.ts";
import { run } from "./action-sequence.ts";

/** Supply the chat event's real message shape when witnessing an action call. */
function emitChatWitness(bot: ScenarioContext["bot"], text: string): void {
  const message = createRequire(import.meta.url)("prismarine-chat")(bot.registry).fromNotch(JSON.stringify({ text }));
  bot.emit("messagestr", text, "system", message);
}

/** Create one sequence step with the runtime's typed result and optional chat during its call. */
function sequenceContext(step: Record<string, unknown>, result: ScenarioCall["result"], chat?: string): ScenarioContext {
  const { bot } = createFakeBot();
  return scenarioTestContext({ bot, scenario: scenarioDefinitionSchema.parse({
    params: { actions: [{ action: "navigate", input: {}, ...step }] }, goal: { kind: "completion" },
  }), call: async (action) => {
    if (chat) emitChatWitness(bot, chat);
    return { action, durationMs: 0, summary: action, result };
  } });
}

test("a legacy client wait is rejected before any action runs", async () => {
  const context = sequenceContext({ waitTicks: 20 }, { status: "succeeded" });
  let calls = 0;
  context.call = async (action) => {
    calls += 1;
    return { action, durationMs: 0, summary: action, result: { status: "succeeded" } };
  };
  await assert.rejects(run(context), { name: "ZodError", message: /waitTicks/u });
  assert.equal(calls, 0);
});

test("a sequence with no wait calls immediately at the initial world age", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const { bot } = createFakeBot({ clock });
  const observed: { age: number; ms: number }[] = [];
  const context = scenarioTestContext({
    bot,
    scenario: scenarioDefinitionSchema.parse({ params: { actions: [{ action: "first", input: {} }] }, goal: { kind: "completion" } }),
    call: async (action) => {
      observed.push({ age: bot.time.age, ms: clock.now() });
      return { action, durationMs: 0, summary: action, result: { status: "succeeded" } };
    },
  });
  assert.equal((await clock.settle(run(context), 0)).status, "succeeded");
  assert.deepEqual(observed, [{ age: 24_000, ms: 0 }]);
});

test("failed steps enforce every required and forbidden error substring", async () => {
  for (const { step, error, status, detail } of [
    { step: { errorContains: ["sealed", "return"] }, error: "sealed return", status: "succeeded" },
    { step: { errorContains: ["sealed", "return"] }, error: "sealed no path", status: "failed", detail: /1\..*return.*sealed no path/u },
    { step: { errorContains: ["sealed", "return"] }, error: "return no path", status: "failed", detail: /1\..*sealed.*return no path/u },
    { step: { errorAbsent: ["[BREATH]"] }, error: "[BREATH] cut", status: "failed", detail: /1\..*\[BREATH\].*cut/u },
    { step: { errorAbsent: ["[BREATH]"] }, error: "sealed return", status: "succeeded" },
  ] as const) {
    const outcome = await run(sequenceContext({ expect: "failed", ...step }, { status: "failed", error }));
    assert.equal(outcome.status, status);
    if (detail) assert.match(outcome.detail ?? "", detail);
  }
});

test("a step requires its chat witness before the result", async () => {
  const step = { awaitChat: "diver_sealed" };
  assert.equal((await run(sequenceContext(step, { status: "succeeded" }, "diver_sealed"))).status, "succeeded");
  const outcome = await run(sequenceContext(step, { status: "succeeded" }));
  assert.equal(outcome.status, "failed");
  assert.match(outcome.detail ?? "", /1\..*diver_sealed/u);
});

test("a successful step ignores error expectations", async () => {
  assert.equal((await run(sequenceContext({ errorContains: ["missing"], errorAbsent: ["anything"] }, { status: "succeeded" }))).status, "succeeded");
});

test("each chat witness is scoped to its step and listeners are released on every exit", async () => {
  for (const row of [
    { step: {}, result: { status: "succeeded" }, chat: "seal" },
    { step: {}, result: { status: "succeeded" } },
    { step: {}, result: { status: "failed", error: "no" } },
    { step: { expect: "failed", errorContains: ["yes"] }, result: { status: "failed", error: "no" }, chat: "seal" },
    { step: { expect: "failed", errorAbsent: ["no"] }, result: { status: "failed", error: "no" }, chat: "seal" },
  ] satisfies { step: Record<string, unknown>; result: ScenarioCall["result"]; chat?: string }[]) {
    const context = sequenceContext({ ...row.step, awaitChat: "seal" }, row.result, row.chat);
    const added = listenersAddedSince(context.bot);
    await run(context);
    assert.equal(added("messagestr"), 0);
  }
  const context = sequenceContext({ awaitChat: "seal" }, { status: "succeeded" });
  const added = listenersAddedSince(context.bot);
  context.call = async () => { throw new Error("call failed"); };
  await assert.rejects(run(context), /call failed/u);
  assert.equal(added("messagestr"), 0);

  const two = scenarioTestContext({ bot: context.bot, scenario: scenarioDefinitionSchema.parse({
    params: { actions: [{ action: "first", input: {}, awaitChat: "seal" }, { action: "second", input: {}, awaitChat: "seal" }] },
    goal: { kind: "completion" },
  }), call: async (action) => {
    if (action === "first") emitChatWitness(context.bot, "seal");
    return { action, durationMs: 0, summary: action, result: { status: "succeeded" } };
  } });
  const outcome = await run(two);
  assert.equal(outcome.status, "failed");
  assert.match(outcome.detail ?? "", /2\..*missing chat/u);
  assert.equal(added("messagestr"), 0);
});

for (const { ticksPerSecond, firstMs, secondMs } of [
  { ticksPerSecond: 20, firstMs: 2_000, secondMs: 4_000 },
  { ticksPerSecond: 10, firstMs: 4_000, secondMs: 8_000 },
]) test(`server waits run in order at ${ticksPerSecond} tps`, async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const { bot } = createFakeBot({ clock, server: { ticksPerSecond } });
  const observed: { action: string; age: number; ms: number }[] = [];
  const context = scenarioTestContext({
    bot,
    scenario: scenarioDefinitionSchema.parse({
      params: { actions: [
        { action: "first", input: {}, waitServerTicks: 20 },
        { action: "second", input: {}, waitServerTicks: 20 },
      ] },
      goal: { kind: "completion" },
    }),
    call: async (action) => {
      observed.push({ action, age: bot.time.age, ms: clock.now() });
      return { action, durationMs: 0, summary: action, result: { status: "succeeded" } };
    },
  });
  assert.equal((await clock.settle(run(context), 12_000)).status, "succeeded");
  assert.deepEqual(observed, [
    { action: "first", age: 24_040, ms: firstMs },
    { action: "second", age: 24_080, ms: secondMs },
  ]);
  assert.equal(clock.pendingGlobalTimers(), 0);
});

test("a stopped server fails the sequence before it sends the action", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const { bot, server } = createFakeBot({ clock });
  server.stop();
  let calls = 0;
  const added = listenersAddedSince(bot);
  const context = scenarioTestContext({
    bot,
    scenario: scenarioDefinitionSchema.parse({ params: { actions: [{ action: "dig", input: {}, waitServerTicks: 20 }] }, goal: { kind: "completion" } }),
    call: async () => { calls += 1; return assert.fail("the step ran on a stopped server"); },
  });
  const completion = await clock.settle(run(context), 30_100);
  assert.equal(completion.status, "failed");
  assert.match(completion.detail ?? "", /the server's clock stood still/);
  assert.equal(clock.now(), 30_000);
  assert.equal(bot.time.age, 24_000);
  assert.equal(calls, 0);
  assert.equal(clock.pendingGlobalTimers(), 0);
  await clock.advance(60_000);
  assert.equal(bot.time.age, 24_000);
  assert.equal(calls, 0);
  assert.equal(clock.pendingGlobalTimers(), 0);
  assert.equal(clock.pendingTimers(), 0);
  assert.equal(added("messagestr"), 0);
});
