// Server-paced steps keep their client-tick wait and run only after the server's packet margin.
import assert from "node:assert/strict";
import test from "node:test";
import { scenarioDefinitionSchema } from "mine-labs";
import { createFakeBot, createFakeClock, listenersAddedSince } from "../../../src/test-support/fake-bot/index.ts";
import { scenarioTestContext } from "../scenario-test-context.ts";
import { run } from "./action-sequence.ts";

function sequence(step: Record<string, unknown>, result: Record<string, unknown>, chat?: string) {
  const { bot } = createFakeBot();
  return scenarioTestContext({ bot, scenario: scenarioDefinitionSchema.parse({
    params: { actions: [{ action: "navigate", input: {}, ...step }] }, goal: { kind: "completion" },
  }), call: async (action) => {
    if (chat) bot.emit("messagestr", chat, "system", {} as never);
    return { action, durationMs: 0, summary: action, result } as never;
  } });
}

test("a forbidden error names the step and forbidden text", async () => {
  const outcome = await run(sequence({ expect: "failed", errorAbsent: ["[BREATH]"] }, { status: "failed", error: "[BREATH] cut" }));
  assert.equal(outcome.status, "failed");
  assert.match(outcome.detail ?? "", /1\..*\[BREATH\]/u);
});

test("a failed step requires each expected error text", async () => {
  const step = { expect: "failed", errorContains: ["sealed"] };
  assert.equal((await run(sequence(step, { status: "failed", error: "sealed return" }))).status, "succeeded");
  const outcome = await run(sequence(step, { status: "failed", error: "no path" }));
  assert.equal(outcome.status, "failed");
  assert.match(outcome.detail ?? "", /1\..*sealed.*no path/u);
});

test("a step requires its chat witness before the result", async () => {
  const step = { awaitChat: "diver_sealed" };
  assert.equal((await run(sequence(step, { status: "succeeded" }, "diver_sealed"))).status, "succeeded");
  const outcome = await run(sequence(step, { status: "succeeded" }));
  assert.equal(outcome.status, "failed");
  assert.match(outcome.detail ?? "", /1\..*diver_sealed/u);
});

test("a successful step ignores error expectations", async () => {
  assert.equal((await run(sequence({ errorContains: ["missing"], errorAbsent: ["anything"] }, { status: "succeeded" }))).status, "succeeded");
});

test("each chat witness is scoped to its step and listeners are released on every exit", async () => {
  for (const row of [
    { step: {}, result: { status: "succeeded" }, chat: "seal" },
    { step: {}, result: { status: "succeeded" } },
    { step: {}, result: { status: "failed", error: "no" } },
    { step: { expect: "failed", errorContains: ["yes"] }, result: { status: "failed", error: "no" }, chat: "seal" },
    { step: { expect: "failed", errorAbsent: ["no"] }, result: { status: "failed", error: "no" }, chat: "seal" },
  ]) {
    const context = sequence({ ...row.step, awaitChat: "seal" }, row.result, row.chat);
    const added = listenersAddedSince(context.bot);
    await run(context);
    assert.equal(added("messagestr"), 0);
  }
  const context = sequence({ awaitChat: "seal" }, { status: "succeeded" });
  const added = listenersAddedSince(context.bot);
  context.call = async () => { throw new Error("call failed"); };
  await assert.rejects(run(context), /call failed/u);
  assert.equal(added("messagestr"), 0);

  const two = scenarioTestContext({ bot: context.bot, scenario: scenarioDefinitionSchema.parse({
    params: { actions: [{ action: "first", input: {}, awaitChat: "seal" }, { action: "second", input: {}, awaitChat: "seal" }] },
    goal: { kind: "completion" },
  }), call: async (action) => {
    if (action === "first") context.bot.emit("messagestr", "seal", "system", {} as never);
    return { action, durationMs: 0, summary: action, result: { status: "succeeded" } };
  } });
  const outcome = await run(two);
  assert.equal(outcome.status, "failed");
  assert.match(outcome.detail ?? "", /2\..*missing chat/u);
  assert.equal(added("messagestr"), 0);
});

for (const ticksPerSecond of [20, 10]) test(`server waits run in order at ${ticksPerSecond} tps`, async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const { bot } = createFakeBot({ clock, server: { ticksPerSecond } });
  const observed: { action: string; age: number }[] = [];
  const context = scenarioTestContext({
    bot,
    scenario: scenarioDefinitionSchema.parse({
      params: { actions: [
        { action: "first", input: {}, waitServerTicks: 20 },
        { action: "second", input: {}, waitTicks: 3, waitServerTicks: 20 },
      ] },
      goal: { kind: "completion" },
    }),
    call: async (action) => {
      observed.push({ action, age: bot.time.age });
      return { action, durationMs: 0, summary: action, result: { status: "succeeded" } };
    },
  });
  context.waitForTicks = async (ticks) => {
    assert.equal(ticks, 3);
    await clock.sleep(1_000);
  };
  assert.equal((await clock.settle(run(context), 12_000)).status, "succeeded");
  assert.deepEqual(observed.map((item) => item.action), ["first", "second"]);
  assert.ok(observed[0]!.age >= 24_040);
  assert.ok(observed[1]!.age - observed[0]!.age >= 40);
});

test("a stopped server fails the sequence before it sends the action", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const { bot, server } = createFakeBot({ clock });
  server.stop();
  const context = scenarioTestContext({
    bot,
    scenario: scenarioDefinitionSchema.parse({ params: { actions: [{ action: "dig", input: {}, waitServerTicks: 20 }] }, goal: { kind: "completion" } }),
    call: async () => assert.fail("the step ran on a stopped server"),
  });
  const completion = await clock.settle(run(context), 30_100);
  assert.equal(completion.status, "failed");
  assert.match(completion.detail ?? "", /the server's clock stood still/);
});
