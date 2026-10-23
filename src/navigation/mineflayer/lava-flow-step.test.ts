import assert from "node:assert/strict";
import test from "node:test";
import { createFakeBot } from "../../test-support/fake-bot/index.js";
import { FakeNavigationBot, flatWorld, observation, onEvent, settle } from "../../test-support/navigation.js";
import { exactBlockGoal } from "../goals/index.js";
import { LAVA_SPREAD_ESCAPE_COST, relaxedForEscape } from "../orchestration/escape-policy.js";
import { createNavigator } from "../orchestration/navigator.js";
import { createMovements } from "../runtime.js";
import type { NavigationEvent } from "../telemetry/index.js";
import type { MemoryWorld } from "../world/memory-world.js";

/**
 * Run 15, `spreading-lava-obstacle-course` (red 3 of 3): a route cell was priced on what it holds now, so a cell the
 * lava would flow into on its next update was walked into and the lava filled it with the bot in it. The rule is the
 * one `advancingLavaAt` holds for the body (`src/world/lava-flow.ts`): lava beside the cell or above it whose level
 * can spread one more step. The floor of `flatWorld` is y 62, the feet cell y 63, the head cell y 64.
 */
const { registry } = createFakeBot().bot;
const FEET = { x: 0, y: 63, z: 0 };
const FALLING = 8;

function lavaAt(world: MemoryWorld, position: { x: number; y: number; z: number }, level: number): void {
  world.load(position, {
    stateId: registry.blocksByName.lava.minStateId + level,
    collisionShapes: [],
    traits: { empty: true, liquid: "lava", liquidSource: level === 0, liquidLevel: level, damaging: true },
  });
}

function decide(world: MemoryWorld, dimension = "overworld") {
  const { bot } = createFakeBot({ dimension });
  return createMovements(bot).decideStep(FEET.x, FEET.y, FEET.z, world);
}

test("a cell beside falling lava is avoided: the lava spreads into it on its next update", () => {
  const world = flatWorld();
  lavaAt(world, { x: 1, y: 63, z: 0 }, FALLING);
  assert.equal(decide(world).kind, "prohibited");
});

test("a cell whose head cell has a falling column landing beside it is avoided; settled flowing lava there is not", () => {
  const landing = flatWorld();
  landing.load({ x: 0, y: 63, z: -1 }, { stateId: 1 });
  lavaAt(landing, { x: 0, y: 64, z: -1 }, FALLING);
  assert.equal(decide(landing).kind, "prohibited");
  // The state a settled stream leaves beside a step (scenario step-up-turn-beside-lava-stream): it reaches the body through the feet row.
  const settled = flatWorld();
  lavaAt(settled, { x: 0, y: 64, z: -1 }, 2);
  assert.equal(decide(settled).kind, "allowed");
});

test("lava above the head cell falls into the cell: avoided", () => {
  const world = flatWorld();
  lavaAt(world, { x: 0, y: 65, z: 0 }, 0);
  assert.equal(decide(world).kind, "prohibited");
});

test("a source beside the cell spreads in the overworld: avoided", () => {
  const world = flatWorld();
  lavaAt(world, { x: 0, y: 63, z: 1 }, 0);
  assert.equal(decide(world).kind, "prohibited");
});

test("still lava at level 6 or 7 cannot spread another step in the overworld: the cell beside it stays open", () => {
  for (const level of [6, 7]) {
    const world = flatWorld();
    lavaAt(world, { x: 1, y: 63, z: 0 }, level);
    assert.equal(decide(world).kind, "allowed", `level ${level}`);
  }
});

test("the Nether's lava loses one level a step: level 6 beside the cell spreads there, level 7 does not", () => {
  const six = flatWorld();
  lavaAt(six, { x: 1, y: 63, z: 0 }, 6);
  assert.equal(decide(six, "the_nether").kind, "prohibited");
  const seven = flatWorld();
  lavaAt(seven, { x: 1, y: 63, z: 0 }, 7);
  assert.equal(decide(seven, "the_nether").kind, "allowed");
});

test("lava two cells away, or beside only diagonally, is not next to the cell: it stays open", () => {
  const far = flatWorld();
  lavaAt(far, { x: 2, y: 63, z: 0 }, FALLING);
  assert.equal(decide(far).kind, "allowed", "one free cell between");
  const diagonal = flatWorld();
  lavaAt(diagonal, { x: 1, y: 63, z: 1 }, FALLING);
  assert.equal(decide(diagonal).kind, "allowed", "lava flows to the four sides and down, not diagonally");
});

test("lava below the floor does not spread up: the cell stays open", () => {
  const world = flatWorld();
  lavaAt(world, { x: 0, y: 61, z: 0 }, 0);
  assert.equal(decide(world).kind, "allowed");
});

test("an escape leg prices the cell instead of refusing it: the last resort, never the first choice", () => {
  const world = flatWorld();
  lavaAt(world, { x: 1, y: 63, z: 0 }, FALLING);
  const { bot } = createFakeBot();
  const decision = relaxedForEscape(createMovements(bot)).decideStep(FEET.x, FEET.y, FEET.z, world);
  assert.deepEqual({ kind: decision.kind, cost: decision.kind === "penalized" ? decision.cost : null }, { kind: "penalized", cost: LAVA_SPREAD_ESCAPE_COST });
});


test("a route goes round a cell beside falling lava, and lava landing beside the route invalidates it", async () => {
  const world = flatWorld();
  // Lava falling at (2, 63, 1): the straight row z=0 has the cell (2, 63, 0) beside it; z=-1 leaves one free cell between.
  lavaAt(world, { x: 2, y: 63, z: 1 }, FALLING);
  const { bot } = createFakeBot();
  const events: NavigationEvent[] = [];
  const nav = new FakeNavigationBot();
  nav.current = observation(0, 63, 0);
  let landed = false;
  const outcome = await settle(
    createNavigator({
      world,
      bot: nav,
      telemetry: onEvent((event) => {
        events.push(event);
        // The column lands in the cell beside the route's cell, as it did at tick 89 of the obstacle course.
        if (event.kind === "route_committed" && !landed) {
          landed = true;
          lavaAt(world, { x: 2, y: 63, z: 0 }, FALLING);
        }
      }),
    }),
    { goal: exactBlockGoal({ x: 4, y: 63, z: 0 }), policy: createMovements(bot) },
  );
  const committed = events.find((event) => event.kind === "route_committed");
  assert.ok(committed?.kind === "route_committed");
  const first = committed.plan.steps.map((step) => `${step.to.x},${step.to.z}`);
  assert.ok(!first.includes("1,0") && !first.includes("2,0") && !first.includes("3,0"), `route ${first.join(" ")} walks beside the lava`);
  assert.ok(
    events.some((event) => event.kind === "world_change" && event.classification === "invalidating"),
    "the lava landing beside a route cell was classified invalidating, not irrelevant",
  );
  assert.ok(outcome.kind === "completed" || outcome.kind === "failed", JSON.stringify(outcome));
});

test("a falling column with lava or air under it pours on: the cell beside it stays open until it lands on a floor", () => {
  const overLava = flatWorld();
  lavaAt(overLava, { x: 1, y: 63, z: 0 }, FALLING);
  lavaAt(overLava, { x: 1, y: 62, z: 0 }, FALLING);
  assert.equal(decide(overLava).kind, "allowed", "lava under the falling cell");
  const overAir = flatWorld();
  lavaAt(overAir, { x: 1, y: 63, z: 0 }, FALLING);
  overAir.load({ x: 1, y: 62, z: 0 }, { stateId: 0 });
  assert.equal(decide(overAir).kind, "allowed", "air under the falling cell");
});
