import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot } from "../../test-support/fake-bot/index.js";
import { WELL_FED, observation, planningStart } from "../../test-support/navigation.js";
import { exactBlockGoal } from "../goals/index.js";
import { createMovementCatalogue } from "../movements/catalogue.js";
import { createMovements } from "../runtime.js";
import { MemoryWorld } from "../world/memory-world.js";
import { IncrementalSearch } from "./search.js";

/*
 * Live 2026-10-10 (run 5, Tom on a 1x1 pillar at y 131, ground 108-111): every long route failed "no path found"
 * (visited 1 to 1154 nodes). With dig_straight_down off a pillar top had no way down but a placed staircase (18 blocks
 * for this 21 block pillar). A block standing free in open air may now be dug straight down whatever the setting.
 * With scaffolds the search is slow (4.7k nodes for 11 of them, over the 2 s failure budget); the 500 ms budget still
 * hands back a segment of the descent, so only the no-scaffold case is pinned here.
 */
const TOP = 131;
const GROUND = 110;
const GOAL = { x: 20, y: GROUND + 1, z: 10 };

/** Stone up to GROUND and a 1x1 pillar at 0,0 up to TOP; everything else air, 51x51 columns loaded. */
let cached: MemoryWorld | undefined;
function pillarWorld(): MemoryWorld {
  if (cached) return cached;
  const world = new MemoryWorld();
  for (let x = -25; x <= 25; x += 1)
    for (let z = -25; z <= 25; z += 1)
      for (let y = GROUND - 1; y <= TOP + 2; y += 1)
        world.load({ x, y, z }, { stateId: y <= GROUND || (x === 0 && z === 0 && y <= TOP) ? 1 : 0 });
  return (cached = world);
}

const LIQUID = {
  water: { stateId: 80, traits: { liquid: "water", liquidSource: true, empty: false, parkourTakeoff: "prohibited", safeToBreak: false } },
  lava: { stateId: 90, traits: { liquid: "lava", liquidSource: true, damaging: true, empty: false, parkourTakeoff: "prohibited", safeToBreak: false } },
} as const;

/** A pillar standing in a lake (or over lava): the liquid fills GROUND and below, the pillar rises from its floor to TOP. */
function lakeWorld(liquid: keyof typeof LIQUID): MemoryWorld {
  const world = new MemoryWorld();
  for (let x = -6; x <= 6; x += 1)
    for (let z = -6; z <= 6; z += 1)
      for (let y = GROUND - 1; y <= TOP + 2; y += 1) {
        const pillar = x === 0 && z === 0 && y <= TOP && y > GROUND;
        world.load({ x, y, z }, pillar ? { stateId: 1 } : y <= GROUND ? LIQUID[liquid] : { stateId: 0 });
      }
  return world;
}

function route(scaffolds: number, digDown: boolean, world: MemoryWorld = pillarWorld(), goalCell = GOAL) {
  const { bot } = createFakeBot({ position: new Vec3(0.5, TOP + 1, 0.5), carried: scaffolds ? { dirt: scaffolds } : {} });
  const start = { x: 0, y: TOP + 1, z: 0 };
  const goal = exactBlockGoal(goalCell).resolve(observation(start.x, start.y, start.z));
  if (goal.kind !== "active") throw new Error(goal.observation);
  const policy = Object.create(createMovements(bot), { allowDownward: { value: digDown } });
  return new IncrementalSearch({
    id: "pillar", start: planningStart(start, scaffolds), goal, now: () => 0,
    context: { world, policy, player: WELL_FED, catalogue: createMovementCatalogue() },
  }).advance({ maximumExpansions: 200_000, maximumMilliseconds: 2_000 });
}

test("pillar top, no scaffolds, straight-down dig on: the route digs down the pillar", () => {
  assert.equal(route(0, true).kind, "complete");
});

test("pillar top, no scaffolds, straight-down dig off: the free-standing column is dug down", () => {
  const result = route(0, false);
  assert.equal(result.kind, "complete");
  if (result.kind !== "complete") return;
  const downs = result.plan.steps.filter((step) => step.kind === "downward");
  assert.ok(downs.length >= 18, `expected the pillar dug down, got ${downs.length} downward steps`);
});

test("flat ground, straight-down dig off: no downward dig (the block has solid neighbours)", () => {
  const result = route(0, false, pillarWorld(), { x: 20, y: GROUND - 6, z: 10 });
  if (result.kind === "complete") assert.equal(result.plan.steps.filter((step) => step.kind === "downward").length, 0);
});

for (const liquid of ["water", "lava"] as const)
  test(`a pillar standing in ${liquid}, straight-down dig off: its base is not dug into the ${liquid}`, () => {
    const result = route(0, false, lakeWorld(liquid), { x: 5, y: GROUND + 1, z: 0 });
    const steps = result.kind === "complete" ? result.plan.steps : [];
    // The base block is never dug: its landing is liquid, not a floor.
    assert.equal(steps.filter((step) => step.kind === "downward" && step.to.y <= GROUND + 1).length, 0);
    // Over lava the route dug down to the last pillar block and stopped there; over water it may drop in (an old rule).
    if (liquid === "lava") {
      assert.equal(result.kind, "no_path");
      if (result.kind === "no_path") assert.equal(result.closest.position.y, GROUND + 2);
    }
  });
