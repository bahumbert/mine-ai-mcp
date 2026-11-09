import assert from "node:assert/strict";
import test from "node:test";
import { CoverWatch, coveredCellReader, firstOpenStep } from "./cover-watch.js";
import { createFakeBot } from "../test-support/fake-bot/index.js";
import { MineflayerWorldView } from "./mineflayer/world.js";
import type { RoutePlan } from "./movements/movement.js";

/** Six walk steps with independently numbered destinations. */
function route(): Pick<RoutePlan, "start" | "steps"> {
  return { start: { x: 0, y: 64, z: 0 }, steps: Array.from({ length: 6 }, (_, i) => ({
    id: `step-${i + 1}`, kind: "walk", from: { x: i, y: 64, z: 0 }, to: { x: i + 1, y: 64, z: 0 },
    validArrivals: [], preconditions: [], operations: [], effects: [],
    cost: { expectedTicks: 5, breakPenalty: 0, placementPenalty: 0, hazardPenalty: 0, total: 5 },
  })) };
}

test("the first uncovered destination is reported, including an already open start; an entirely covered or empty route has none", () => {
  assert.deepEqual(firstOpenStep(route(), ({ x }) => x < 4), { stepId: "step-4", at: { x: 4, y: 64, z: 0 } });
  assert.equal(firstOpenStep(route(), () => true), null);
  assert.deepEqual(firstOpenStep(route(), () => false), { stepId: "step-1", at: { x: 1, y: 64, z: 0 } });
  assert.equal(firstOpenStep({ start: { x: 0, y: 64, z: 0 }, steps: [] }, () => false), null);
});

test("a later segment replaces the report and only its own run and step can mark it reached", () => {
  const watch = new CoverWatch(() => false);
  const plan = { ...route(), end: { x: 6, y: 64, z: 0 }, complete: true };
  watch.observe({ kind: "route_committed", runId: "one", planId: "a", atMs: 0, steps: 6, plan }, true);
  watch.observe({ kind: "step_started", runId: "one", planId: "a", stepId: "step-1", movement: "walk", atMs: 0 }, true);
  assert.equal(watch.snapshot()?.reached, true);
  watch.observe({ kind: "route_committed", runId: "two", planId: "b", atMs: 0, steps: 6, plan }, true);
  assert.equal(watch.snapshot()?.reached, false);
  watch.observe({ kind: "step_started", runId: "one", planId: "a", stepId: "step-1", movement: "walk", atMs: 0 }, true);
  assert.equal(watch.snapshot()?.reached, false);
});

test("reading cover visits each covered destination once", () => {
  const cells = Object.fromEntries(Array.from({ length: 200 }, (_, x) => [`${x + 1},66,0`, "stone"]));
  const { bot, world: fakeWorld } = createFakeBot({ cells });
  // The live client already holds decoded columns; the fake builds its Prismarine columns lazily (fake-world-columns.ts).
  for (let chunkX = 0; chunkX <= 12; chunkX++) fakeWorld.getColumn(chunkX, 0);
  const world = new MineflayerWorldView(bot);
  let reads = 0;
  const blockAt = world.blockAt.bind(world);
  world.blockAt = (...args) => { reads++; return blockAt(...args); };
  try {
    const covered = coveredCellReader(bot, world);
    const step = route().steps[0]!;
    const plan = { start: route().start, steps: Array.from({ length: 200 }, (_, x) => ({ ...step, id: `${x}`, to: { x: x + 1, y: 64, z: 0 } })) };
    const exit = firstOpenStep(plan, covered);
    assert.equal(exit, null);
    assert.equal(reads, 200);
  } finally { world.close(); }
});
