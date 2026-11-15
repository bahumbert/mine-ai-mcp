// A ghost-air hold samples client physics for a whole server interval, including its packet margin.
import assert from "node:assert/strict";
import test from "node:test";
import { scenarioDefinitionSchema } from "mine-labs";
import { createFakeBot, createFakeClock } from "../../../src/test-support/fake-bot/index.ts";
import { scenarioTestContext } from "../scenario-test-context.ts";
import { run } from "./ghost-air-resync.ts";

// +20 age packets: contract/checks/world-age-at-slow-tick.ts. Client sampling remains 50 ms (physics.js).
test("the hold spans server ticks at 20 and 5 tps, judging airborne on samples and keeping the height check", async () => {
  for (const { rate, airborne, fall, status, samples } of [
    { rate: 20, airborne: Infinity, fall: 0, status: "succeeded", samples: 40 },
    { rate: 5, airborne: Infinity, fall: 0, status: "succeeded", samples: 160 },
    { rate: 5, airborne: 20, fall: 0, status: "failed", samples: 160 },
    { rate: 5, airborne: 80, fall: 0, status: "succeeded", samples: 160 },
    { rate: 20, airborne: Infinity, fall: 0.31, status: "failed", samples: 40 },
  ]) {
    const clock = createFakeClock({ mode: "mocked" });
    using _timers = clock.install();
    const { bot } = createFakeBot({ clock, server: { ticksPerSecond: rate } });
    let sampled = 0;
    let navigated = false;
    bot.on("physicsTick", () => { sampled += 1; });
    const context = scenarioTestContext({
      bot,
      scenario: scenarioDefinitionSchema.parse({
        params: { holdTicks: 20, cases: [{ target: [5, 64, 0] }], openedWindowsAllowed: 0 },
        goal: { kind: "completion" },
      }),
      client: { body: () => ({ x: 0.5, y: 64 - (sampled > 0 ? fall : 0), z: 0.5, onGround: sampled > airborne }) },
      call: async (action) => {
        navigated = true;
        return { action, durationMs: 0, summary: action, result: { status: "succeeded" } };
      },
    });
    const result = await clock.settle(run(context), 8_100);
    assert.equal(result.status, status, JSON.stringify({ rate, airborne, fall, result }));
    assert.equal(sampled, samples, `sample count at ${rate} tps`);
    assert.equal(navigated, status === "succeeded");
  }
});

test("a stopped server fails the hold without navigating", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const { bot, server } = createFakeBot({ clock });
  server.stop();
  const context = scenarioTestContext({
    bot,
    scenario: scenarioDefinitionSchema.parse({
      params: { holdTicks: 20, cases: [{ target: [5, 64, 0] }], openedWindowsAllowed: 0 },
      goal: { kind: "completion" },
    }),
    client: { body: () => ({ x: 0.5, y: 64, z: 0.5, onGround: false }) },
    call: async () => assert.fail("navigated with a stopped server"),
  });
  const result = await clock.settle(run(context), 30_100);
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /the server's clock stood still/);
});
