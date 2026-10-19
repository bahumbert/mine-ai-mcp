import assert from "node:assert/strict";
import test from "node:test";
import { WELL_FED, movementStep, observation, planningStart } from "../../test-support/navigation.js";
import { exactBlockGoal } from "../goals/index.js";
import type { RoutePlan } from "../movements/movement.js";
import { createMovementCatalogue } from "../movements/catalogue.js";
import { createMovementPolicy } from "../movements/policy.js";
import { MemoryWorld } from "../world/memory-world.js";
import { IncrementalSearch } from "./search.js";
import { endsStrandedUnderWater } from "./stranded-segment.js";

/*
 * Run 15, Sana (18:40): a navigate committed a 6-step swim segment into a roofed tunnel and the next search failed,
 * leaving her five blocks inside with no air pocket within a breath. A partial segment that ends under water, under a
 * roof, out of one breath of a breathable cell is not committed.
 */
const FLOOR = 58;
const ROOF = 61;

/** An air pocket at x -3..0, then a water tunnel (z 0, y 59-60) closed by a wall at `wallX`, all roofed in stone. */
function roofedTunnel(wallX: number): MemoryWorld {
  const world = new MemoryWorld();
  for (let x = -4; x <= 40; x++)
    for (let z = -2; z <= 2; z++)
      for (let y = FLOOR; y <= ROOF + 1; y++) {
        const inTunnel = z === 0 && y > FLOOR && y < ROOF && x < wallX;
        world.load({ x, y, z }, !inTunnel
          ? { stateId: 1 }
          : x <= 0 ? { stateId: 0 } : { stateId: 2, traits: { empty: true, liquid: "water", liquidSource: true, safeToBreak: false } });
      }
  return world;
}

function dive(wallX: number, airTicks: number) {
  const start = { x: 0, y: FLOOR + 1, z: 0 };
  const goal = exactBlockGoal({ x: 40, y: FLOOR + 1, z: 0 }).resolve(observation(0, start.y, 0));
  if (goal.kind !== "active") throw new Error(goal.observation);
  return new IncrementalSearch({
    id: "roofed-dive", start: planningStart(start), goal, now: () => 0,
    limits: { primaryTimeoutMs: 0, failureTimeoutMs: 1_000 },
    context: {
      world: roofedTunnel(wallX),
      policy: createMovementPolicy({ allowDigging: false, allowPlacing: false, dive: { origin: start, airTicks } }),
      player: WELL_FED, catalogue: createMovementCatalogue(),
    },
  }).advance({ maximumExpansions: 100_000, maximumMilliseconds: 5_000 });
}

test("a short dive into a roofed tunnel within one breath of the pocket is still committed", () => {
  const update = dive(8, 400);
  assert.equal(update.kind, "segment_ready", update.kind);
  assert.ok(update.plan.steps.some((step) => step.kind === "swim"));
});

test("a partial segment that ends deep in a roofed tunnel, out of one breath of air, is not committed (Sana)", () => {
  const update = dive(30, 200);
  assert.notEqual(update.kind, "segment_ready", update.kind === "segment_ready" ? `ends at ${JSON.stringify(update.plan.end)}` : update.kind);
});

/** A plan of `cells` swim strokes east from the pocket at x 0 along the tunnel, each priced at a stroke's ticks. */
function swimPlan(cells: number): Pick<RoutePlan, "steps" | "endNode"> {
  const steps = Array.from({ length: cells }, (_, index) =>
    movementStep("swim", { x: index, y: FLOOR + 1, z: 0 }, { x: index + 1, y: FLOOR + 1, z: 0 }, { expectedTicks: 14 }));
  return { steps, endNode: { feet: { x: cells, y: FLOOR + 1, z: 0 }, remainingScaffolds: 0, overlayId: 0 as never } };
}
const withAir = (airTicks: number) => createMovementPolicy({ dive: { origin: { x: 0, y: FLOOR + 1, z: 0 }, airTicks } });

test("a segment's end is stranded when the way back to the pocket plus the reserve exceeds the air left (Sana)", () => {
  const world = roofedTunnel(30);
  assert.equal(endsStrandedUnderWater(world, withAir(300), swimPlan(6)), false, "6 strokes out, 6 back, reserve: 300 is enough");
  assert.equal(endsStrandedUnderWater(world, withAir(200), swimPlan(6)), true, "not with 200");
  assert.equal(endsStrandedUnderWater(world, withAir(10_000), swimPlan(25)), true, "beyond the search radius no air is known: stranded whatever the air");
  assert.equal(endsStrandedUnderWater(world, createMovementPolicy(), swimPlan(25)), false, "no dive admission: not a dive");
});
