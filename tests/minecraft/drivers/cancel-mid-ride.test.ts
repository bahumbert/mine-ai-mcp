import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadScenario, scenarioDefinitionSchema } from "mine-labs";
import { Vec3 } from "vec3";
import { createFakeBot, createFakeClock } from "../../../src/test-support/fake-bot/index.ts";
import { arenaFrame } from "../arena/frame.ts";
import { scenarioTestContext } from "../scenario-test-context.ts";
import { run } from "./cancel-mid-ride.ts";

/** Moves x as well as z, so the lines the bot crosses (read as x) are in the lane's frame, not the arena's. */
// check-reads: tests/minecraft/scenarios/pathfinder/boat-ride-cancelled-then-navigate.yaml, tests/minecraft/templates/**/*.yaml
const FRAME = arenaFrame({ x: 64, z: 512 });
const PARAMS = { target: [105, -60, 0], cancelPastX: 30, farBankX: 90, settleWithinMs: 5_000 };
const BOAT_ID = 100;

/** A bot seated in a boat at world x 80: past the arena's cancel line (30) but not the lane's (94). */
function seatedBot() {
  const harness = createFakeBot({
    clock: createFakeClock({ mode: "mocked" }),
    position: new Vec3(80, -60, 512.5),
    entities: { [BOAT_ID]: { name: "oak_boat", position: new Vec3(80, -60, 512.5) } },
  });
  const { bot } = harness;
  bot.entity.vehicle = bot.entities[BOAT_ID]!;
  return harness;
}

test("the cancel waits for the bot to pass cancelPastX in the lane's frame", async () => {
  const harness = seatedBot();
  const { bot, clock } = harness;
  using _clock = clock.install();
  clock.after(250, () => bot.entity.position.set(95, -60, 512.5));
  let xAtCancel: number | null = null;
  const context = scenarioTestContext({
    scenario: scenarioDefinitionSchema.parse({ params: PARAMS, goal: { kind: "completion" } }),
    arena: FRAME,
    bot,
    call: async (action, input) => {
      if (action === "cancel_foreground_action") {
        xAtCancel = bot.entity.position.x;
        throw new Error("cancel seen");
      }
      assert.deepEqual([input.x, input.y, input.z], [169, -60, 512], "the far land, in the lane");
      return new Promise(() => {});
    },
  });
  await clock.settle(run(context).then(
    () => assert.fail("the driver ran on past the cancel"),
    (cause: Error) => assert.equal(cause.message, "cancel seen"),
  ), 10_000);
  assert.ok(xAtCancel !== null && xAtCancel >= 94, `cancelled at x ${xAtCancel}, before the lane's line at 94`);
});

test("a clone-length server pause during stop measurement still reaches the next ride in the lane's frame", async () => {
  const harness = seatedBot();
  const { bot } = harness;
  using _clock = harness.clock.install();
  bot.entity.position.set(95, -60, 512.5);
  let cancelled: (() => void) | undefined;
  let rides = 0;
  const context = scenarioTestContext({
    scenario: scenarioDefinitionSchema.parse({ params: PARAMS, goal: { kind: "completion" } }),
    arena: FRAME,
    bot,
    call: async (action) => {
      const summary = action;
      if (action === "cancel_foreground_action") {
        harness.server.stop();
        harness.clock.after(3_500, () => harness.server.resume());
        cancelled?.();
        return { action, durationMs: 1, result: { status: "succeeded" }, summary };
      }
      rides += 1;
      if (rides === 1) {
        await new Promise<void>((resolve) => void (cancelled = resolve));
        return { action, durationMs: 1, result: { status: "cancelled", error: "cancelled" }, summary };
      }
      // The second ride: the bot leaves the boat at world x 100, short of the lane's far bank (154), past the arena's (90).
      Object.assign(bot.entity, { vehicle: null }); // prismarine-entity types the vehicle non-null; a dismount clears it
      await harness.clock.sleep(300);
      return { action, durationMs: 300, result: { status: "succeeded" }, summary };
    },
  });
  const completion = await harness.clock.settle(run(context), 10_000);
  assert.equal(completion.status, "failed");
  assert.match(completion.detail ?? "", /the bot left the boat before the far bank/);
});

for (const stallAfterFirstWait of [false, true]) {
  test(`a server stopped ${stallAfterFirstWait ? "after" : "before"} the first boat wait fails without a second ride`, async () => {
    const clock = createFakeClock({ mode: "mocked" });
    using _timers = clock.install();
    const harness = createFakeBot({ clock, position: new Vec3(95, -60, 512.5),
      entities: { [BOAT_ID]: { name: "oak_boat", position: new Vec3(95, -60, 512.5) } } });
    const { bot, server } = harness;
    bot.entity.vehicle = bot.entities[BOAT_ID]!;
    let finishRide!: () => void;
    let rides = 0;
    const context = scenarioTestContext({
      scenario: scenarioDefinitionSchema.parse({ params: PARAMS, goal: { kind: "completion" } }), arena: FRAME, bot,
      call: async (action) => {
        if (action === "cancel_foreground_action") {
          finishRide();
          if (stallAfterFirstWait) {
            const initialAge = bot.time.age;
            server.onTimePacket(() => { if (bot.time.age >= initialAge + 60) server.stop(); });
          } else server.stop();
          return { action, durationMs: 0, result: { status: "succeeded" }, summary: action };
        }
        rides += 1;
        await new Promise<void>((resolve) => { finishRide = resolve; });
        return { action, durationMs: 0, result: { status: "cancelled", error: "cancelled" }, summary: action };
      },
    });
    const result = await clock.settle(run(context), 35_000);
    assert.equal(result.status, "failed");
    assert.match(result.detail ?? "", /the server's clock stood still/);
    assert.equal(rides, 1);
    assert.equal(bot.time.age, 24_000 + (stallAfterFirstWait ? 60 : 0));
    assert.equal(clock.now(), stallAfterFirstWait ? 33_000 : 30_000);
  });
}

test("the boat-ride scenario's own params are the ones the driver reads, and its first call is the navigate to the far land", async () => {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "../scenarios/pathfinder/boat-ride-cancelled-then-navigate.yaml");
  const { client: _launch, ...scenario } = await loadScenario(file);
  const asked: { action: string; input: Record<string, unknown> }[] = [];
  const context = scenarioTestContext({
    scenario: scenarioDefinitionSchema.parse(scenario),
    bot: seatedBot().bot,
    call: async (action, input) => {
      asked.push({ action, input });
      // The navigate rides on; the bot already sits past the line, so the driver's next call is the cancel, which ends the run here.
      if (action === "cancel_foreground_action") throw new Error("cancel seen");
      return new Promise(() => {});
    },
  });
  await assert.rejects(run(context), /cancel seen/);
  assert.deepEqual(asked[0], { action: "navigate", input: { x: 105, y: -60, z: 0, range: 2 } });
});
