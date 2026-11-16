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

test("an evade search picks a near covered cell over a straight open run", () => {
  const world = new MemoryWorld();
  for (let x = -50; x <= 60; x++) for (let z = -50; z <= 50; z++) {
    world.load({ x, y: 62, z }, { stateId: 1 });
    for (let y = 63; y <= 66; y++) world.load({ x, y, z }, { stateId: x === 10 && z >= 4 && z <= 10 && y <= 65 ? 1 : 0 });
  }
  const shooter = { id: 7, position: { x: 0, y: 63, z: 0 }, cover: { minRange: 8, eyeHeight: 1.6, width: 0.6 } };
  for (const cover of [true, false]) {
    const entity = cover ? shooter : { id: shooter.id, position: shooter.position };
    const goal = safeFromEntitiesGoal([entity], 44, { follow: "snapshot" }).resolve(observation());
    assert.equal(goal.kind, "active");
    if (goal.kind !== "active") throw new Error("inactive goal");
    const search = new IncrementalSearch({ id: goal.revision, start: planningStart({ x: 0, y: 63, z: 0 }), goal,
      limits: { primaryTimeoutMs: 500, maximumRadius: 48 }, now: () => 0,
      context: { world, policy: createMovementPolicy(), player: WELL_FED, catalogue: createMovementCatalogue() } });
    const result = search.advance({ maximumExpansions: 100_000, maximumMilliseconds: Infinity });
    assert.equal(result.kind, "complete");
    if (result.kind !== "complete") throw new Error("search incomplete");
    const distance = Math.hypot(result.plan.end.x, result.plan.end.z);
    if (cover) assert.ok(distance < 20 && result.plan.end.x > 10, JSON.stringify(result.plan.end));
    else assert.ok(distance >= 44, JSON.stringify(result.plan.end));
  }
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
