/** Search chooses cover when it makes a nearer escape possible. */
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot, createFakeClock } from "../../test-support/fake-bot/index.js";
import { WELL_FED, observation, planningStart } from "../../test-support/navigation.js";
import { exactBlockGoal, safeFromEntitiesGoal } from "../goals/index.js";
import { createMovementCatalogue } from "../movements/catalogue.js";
import { createMovementPolicy } from "../movements/policy.js";
import { MemoryWorld } from "../world/memory-world.js";
import { createNavigationRuntime } from "../runtime.js";
import { IncrementalSearch } from "./search.js";
import type { PlanningState } from "../movements/catalogue.js";

/** The flat arena's diggable surface and optional standing wall (1.21.4 block states). */
function diggableArena(wall = false): MemoryWorld {
  const world = new MemoryWorld();
  for (let x = -50; x <= 60; x++) for (let z = -50; z <= 50; z++) for (let y = 59; y <= 66; y++) {
    const stateId = y === 59 ? 85 : y <= 61 ? 10 : y === 62 ? 9
      : wall && x === 16 && z >= 3 && z <= 9 && y <= 65 ? 1 : 0;
    world.load({ x, y, z }, { stateId, traits: { safeToBreak: stateId !== 0 && y !== 59 } });
  }
  return world;
}

/** Exercise the evade's normal movement policy, including digging, from the supplied planning state. */
function searchDiggableArena(world: MemoryWorld, start: PlanningState, cover = true, range = 36) {
  const goal = safeFromEntitiesGoal([{ id: 7, position: { x: 0, y: 63, z: 0 },
    ...(cover ? { cover: { minRange: 8, eyeHeight: 1.74, width: 0.6 } } : {}) }], range, { follow: "snapshot" })
    .resolve(observation(start.node.feet.x));
  assert.equal(goal.kind, "active");
  if (goal.kind !== "active") throw new Error("inactive goal");
  const search = new IncrementalSearch({ id: goal.revision, start, goal,
    limits: { primaryTimeoutMs: 500, maximumRadius: 48 }, now: () => 0,
    context: { world, policy: createMovementPolicy(), player: WELL_FED, catalogue: createMovementCatalogue() } });
  const result = search.advance({ maximumExpansions: 100_000, maximumMilliseconds: Infinity });
  assert.equal(result.kind, "complete");
  if (result.kind !== "complete") throw new Error("search incomplete");
  return result;
}

test("an evade search on diggable open ground runs instead of digging a pit", () => {
  const started = performance.now();
  const result = searchDiggableArena(diggableArena(), planningStart({ x: 8, y: 63, z: 0 }));
  console.log(`Diggable open evade: visited ${result.evidence.visited}, wall ${(performance.now() - started).toFixed(1)} ms`);
  assert.ok(Math.hypot(result.plan.end.x, result.plan.end.z) >= 36, JSON.stringify(result.plan.end));
  assert.equal(result.plan.end.y, 63);
  assert.equal(result.plan.steps.some((step) => step.operations.some((operation) => operation.kind === "break")), false);
});

test("standing cover shortens an evade on diggable ground only when the goal allows cover", () => {
  const world = diggableArena(true);
  for (const [x, cover, range] of [[5, true, 36], [8, true, 36], [10, true, 36], [8, false, 44]] as const) {
    const { plan } = searchDiggableArena(world, planningStart({ x, y: 63, z: 0 }), cover, range);
    if (cover) {
      assert.equal(plan.end.x, 17, JSON.stringify(plan.end));
      assert.ok(plan.end.z >= 3 && plan.end.z <= 9, JSON.stringify(plan.end));
    } else assert.ok(Math.hypot(plan.end.x, plan.end.z) >= 44, JSON.stringify(plan.end));
    assert.equal(plan.end.y, 63);
    assert.equal(plan.steps.some((step) => step.operations.some((operation) => operation.kind === "break")), false);
  }
});

test("an ahead search over pending edits finds no cover", () => {
  const start = planningStart({ x: 8, y: 63, z: 0 });
  const overlay = start.overlay.apply({ kind: "break", position: { x: 30, y: 62, z: 30 }, stateId: 0 });
  const { plan } = searchDiggableArena(diggableArena(true), { overlay, node: { ...start.node, overlayId: overlay.identity } });
  assert.ok(Math.hypot(plan.end.x, plan.end.z) >= 36, JSON.stringify(plan.end));
});

test("an exposed evade returns outward progress when its search budget expires", () => {
  const world = new MemoryWorld();
  for (let x = -50; x <= 60; x++) for (let z = -50; z <= 50; z++) {
    world.load({ x, y: 62, z }, { stateId: 1 });
    for (let y = 63; y <= 66; y++) world.load({ x, y, z }, { stateId: 0 });
  }
  const goal = safeFromEntitiesGoal([{ id: 7, position: { x: 0, y: 63, z: 0 },
    cover: { minRange: 8, eyeHeight: 1.6, width: 0.6 } }], 44, { follow: "snapshot" }).resolve(observation(12));
  assert.equal(goal.kind, "active");
  if (goal.kind !== "active") throw new Error("inactive goal");
  let spent = 0;
  const catalogue = createMovementCatalogue();
  const search = new IncrementalSearch({ id: goal.revision, start: planningStart({ x: 12, y: 63, z: 0 }), goal,
    limits: { primaryTimeoutMs: 500, failureTimeoutMs: 500, maximumRadius: 48 }, now: () => spent,
    context: { world, policy: createMovementPolicy(), player: WELL_FED,
      catalogue: { generate: (...args) => { spent++; return catalogue.generate(...args); } } } });
  const result = search.advance({ maximumExpansions: 100_000, maximumMilliseconds: Infinity });
  assert.ok(result.kind === "complete" || result.kind === "segment_ready", JSON.stringify(result));
  if (result.kind !== "complete" && result.kind !== "segment_ready") return;
  assert.ok(Math.hypot(result.plan.end.x, result.plan.end.z) > 12);
});

test("a covered arrival releases navigation for the next route", async () => {
  const clock = createFakeClock({ mode: "manual" });
  const cells: Record<string, string> = {};
  for (let y = 63; y <= 66; y++) for (let z = -3; z <= 3; z++) cells[`10,${y},${z}`] = "stone";
  const { bot } = createFakeBot({ clock, simulatePhysics: true, position: new Vec3(12.5, 63, 0.5), groundY: 62, cells });
  const navigation = createNavigationRuntime(bot);
  const movements = createMovementPolicy({ allowDigging: false, allowParkour: false });
  try {
    const goal = safeFromEntitiesGoal([{ id: 7, position: { x: 0, y: 63, z: 0 },
      cover: { minRange: 8, eyeHeight: 1.6, width: 0.6 } }], 44, { follow: "snapshot" });
    assert.equal((await clock.settle(navigation.navigate({ movements, goal }), 20_000)).status, "completed");
    assert.equal((await clock.settle(navigation.navigate({ movements, goal: exactBlockGoal({ x: 14, y: 63, z: 0 }) }), 20_000)).status, "completed");
    assert.equal(navigation.active, false);
    assert.equal(Math.floor(bot.entity.position.x), 14);
  } finally {
    await clock.settle(navigation.close(), 20_000);
  }
});
