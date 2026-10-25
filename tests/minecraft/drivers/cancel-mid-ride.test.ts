import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadScenario, scenarioDefinitionSchema } from "mine-labs";
import { Vec3 } from "vec3";
import { createFakeBot } from "../../../src/test-support/fake-bot/index.ts";
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
  const { bot } = createFakeBot({
    position: new Vec3(80, -60, 512.5),
    entities: { [BOAT_ID]: { name: "oak_boat", position: new Vec3(80, -60, 512.5) } },
  });
  bot.entity.vehicle = bot.entities[BOAT_ID]!;
  return bot;
}

test("the cancel waits for the bot to pass cancelPastX in the lane's frame", async () => {
  const bot = seatedBot();
  const crossesLine = setTimeout(() => bot.entity.position.set(95, -60, 512.5), 250);
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
  await run(context).then(
    () => assert.fail("the driver ran on past the cancel"),
    (cause: Error) => assert.equal(cause.message, "cancel seen"),
  );
  clearTimeout(crossesLine);
  assert.ok(xAtCancel !== null && xAtCancel >= 94, `cancelled at x ${xAtCancel}, before the lane's line at 94`);
});

test("leaving the boat short of the far bank is read in the lane's frame", async () => {
  const bot = seatedBot();
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
      await new Promise((resolve) => setTimeout(resolve, 300));
      return { action, durationMs: 300, result: { status: "succeeded" }, summary };
    },
  });
  const completion = await run(context);
  assert.equal(completion.status, "failed");
  assert.match(completion.detail ?? "", /the bot left the boat before the far bank/);
});

test("the boat-ride scenario's own params are the ones the driver reads, and its first call is the navigate to the far land", async () => {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "../scenarios/pathfinder/boat-ride-cancelled-then-navigate.yaml");
  const { client: _launch, ...scenario } = await loadScenario(file);
  const asked: { action: string; input: Record<string, unknown> }[] = [];
  const context = scenarioTestContext({
    scenario: scenarioDefinitionSchema.parse(scenario),
    bot: seatedBot(),
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
