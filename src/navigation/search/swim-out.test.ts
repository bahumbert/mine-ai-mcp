import assert from "node:assert/strict";
import test from "node:test";
import { WELL_FED, observation, planningStart } from "../../test-support/navigation.js";
import { exactBlockGoal } from "../goals/index.js";
import { createMovementCatalogue } from "../movements/catalogue.js";
import { createMovementPolicy } from "../movements/policy.js";
import { MemoryWorld } from "../world/memory-world.js";
import { IncrementalSearch } from "./search.js";

const SEA_FLOOR = 58;
const SURFACE = 66;
const SHORE_X = 20;

/** A sea eight deep with a roof over x -1..1 at y 62, and a stone shore from SHORE_X east. */
function seaUnderOverhang(): MemoryWorld {
  const world = new MemoryWorld();
  for (let x = -6; x <= SHORE_X + 3; x++)
    for (let z = -4; z <= 4; z++)
      for (let y = SEA_FLOOR; y <= SURFACE + 3; y++) {
        const shore = x >= SHORE_X && y <= SURFACE;
        const roof = x >= -1 && x <= 1 && y === 62;
        world.load(
          { x, y, z },
          y === SEA_FLOOR || shore || roof
            ? { stateId: 1 }
            : y <= SURFACE
              ? { stateId: 2, traits: { empty: true, liquid: "water", liquidSource: true, safeToBreak: false } }
              : { stateId: 0 },
        );
      }
  return world;
}

function route(airTicks: number) {
  const start = { x: 0, y: SEA_FLOOR + 1, z: 0 };
  const goal = exactBlockGoal({ x: SHORE_X + 1, y: SURFACE + 1, z: 0 }).resolve(observation(0, start.y, 0));
  if (goal.kind !== "active") throw new Error(goal.observation);
  return new IncrementalSearch({
    id: "swim-out",
    start: planningStart(start),
    goal,
    now: () => 0,
    context: {
      world: seaUnderOverhang(),
      policy: createMovementPolicy({ allowDigging: false, allowPlacing: false, dive: { origin: start, airTicks } }),
      player: WELL_FED,
      catalogue: createMovementCatalogue(),
    },
  });
}

test("a bot on the sea floor under an overhang plans its swim out to a shore twenty blocks away", () => {
  const update = route(600).advance({ maximumExpansions: 200_000, maximumMilliseconds: 5_000 });
  assert.ok(update.kind === "complete" || update.kind === "segment_ready", update.kind);
  assert.ok(update.plan.steps.some((step) => step.kind === "swim"), "the way out is swum");
});

test("with less air than the swim out needs, no route is planned under the overhang", () => {
  const update = route(60).advance({ maximumExpansions: 200_000, maximumMilliseconds: 5_000 });
  assert.notEqual(update.kind, "complete");
});
