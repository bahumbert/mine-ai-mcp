// Server-paced steps keep their client-tick wait and run only after the server's packet margin.
import assert from "node:assert/strict";
import test from "node:test";
import { scenarioDefinitionSchema } from "mine-labs";
import { createFakeBot, createFakeClock } from "../../../src/test-support/fake-bot/index.ts";
import { scenarioTestContext } from "../scenario-test-context.ts";
import { run } from "./action-sequence.ts";

test("server ticks parse with the client wait defaulting to zero, and both waits run in order", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const { bot } = createFakeBot({ clock });
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
  assert.equal((await clock.settle(run(context), 6_000)).status, "succeeded");
  assert.deepEqual(observed, [{ action: "first", age: 24_040 }, { action: "second", age: 24_100 }]);
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
