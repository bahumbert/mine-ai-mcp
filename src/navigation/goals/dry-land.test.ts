import assert from "node:assert/strict";
import test from "node:test";
import minecraftData from "minecraft-data";
import type { Bot } from "mineflayer";
import { WELL_FED, observation, planningStart } from "../../test-support/navigation.js";
import { loadNamedBlock } from "../../test-support/layered-world.js";
import { createMovementCatalogue } from "../movements/catalogue.js";
import { createMovementPolicy } from "../movements/policy.js";
import { IncrementalSearch } from "../search/search.js";
import { MemoryWorld } from "../world/memory-world.js";
import { dryLandGoal } from "./dry-land.js";

const SEA_FLOOR = 58;
const SURFACE = 66;
const WATER = { stateId: 2, traits: { empty: true, liquid: "water", liquidSource: true, safeToBreak: false } } as const;

/** A sea eight deep (surface y 66) from x -6 to `shore - 1`, z -4 to 4, and land (stone up to the surface) from `shore` on. */
function seaWithLandAt(shore: number): MemoryWorld {
  const world = new MemoryWorld();
  for (let x = -6; x <= shore + 3; x++)
    for (let z = -4; z <= 4; z++)
      for (let y = SEA_FLOOR; y <= SURFACE + 3; y++)
        world.load({ x, y, z }, y === SEA_FLOOR || (x >= shore && y <= SURFACE) ? { stateId: 1 } : y <= SURFACE ? WATER : { stateId: 0 });
  return world;
}

test("from open water the nearest dry ground 41 blocks away is found within the default search limits (run 16, Yuki)", () => {
  const start = { x: 0, y: SURFACE, z: 0 };
  const goal = dryLandGoal(start.y).resolve(observation(0, start.y, 0));
  if (goal.kind !== "active") throw new Error(goal.observation);
  const search = new IncrementalSearch({
    id: "dry-land",
    start: planningStart(start),
    goal,
    now: () => 0,
    context: { world: seaWithLandAt(41), policy: createMovementPolicy({ allowDigging: false, allowPlacing: false }), player: WELL_FED, catalogue: createMovementCatalogue() },
  });
  const update = search.advance({ maximumExpansions: 200_000, maximumMilliseconds: 2_000 });
  assert.equal(update.kind, "complete");
  assert.ok(update.kind === "complete" && update.plan.steps.at(-1)!.to.x >= 41, "the route ends on the land");
});

test("a cell in a kelp column is never dry ground", () => {
  const world = new MemoryWorld();
  const registryBot = { registry: minecraftData("1.21.4") } as Pick<Bot, "registry">;
  loadNamedBlock(world, registryBot, { x: 0, y: 59, z: 0 }, "dirt");
  loadNamedBlock(world, registryBot, { x: 0, y: 60, z: 0 }, "kelp_plant");
  loadNamedBlock(world, registryBot, { x: 0, y: 61, z: 0 }, "kelp");
  const goal = dryLandGoal(61).resolve(observation(0, 61, 0));
  if (goal.kind !== "active") throw new Error(goal.observation);
  assert.equal(goal.isSatisfied({ feet: { x: 0, y: 60, z: 0 }, remainingScaffolds: 0, overlayId: "" }, world), false);
});
