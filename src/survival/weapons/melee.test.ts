import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { MemoryWorld as GoalTestWorld } from "../../navigation/world/memory-world.js";
import { type FakeEntitySpec, createFakeBot } from "../../test-support/fake-bot/index.js";
import { flatWorld, observation } from "../../test-support/navigation.js";
import { entityDimensions } from "../../world/entity-dimensions.js";
import { hasMeleeKnockbackRoom, meleeApproachGoal, meleeDistance } from "./melee.js";

const goalTestWorld = new GoalTestWorld();
const TARGET_ID = 7;

/** The fake bot with its feet at `feet` and `target` as entity 7, returned as the bot sees it. */
function sceneWith(feet: Vec3, target: FakeEntitySpec) {
  const { bot, world } = createFakeBot({ position: feet, entities: { [TARGET_ID]: target } });
  return { bot, world, target: bot.entities[TARGET_ID]! };
}

/** An empty slime or magma cube metadata, its `size` written at the registry's index by `sized`. */
function cubeSize(name: "slime" | "magma_cube") {
  const metadata: unknown[] = [];
  return { metadata, sized: (bot: { registry: { entitiesByName: Record<string, { metadataKeys?: string[] } | undefined> } }, size: number) => {
    metadata[bot.registry.entitiesByName[name]!.metadataKeys!.indexOf("size")] = size;
  } };
}

test("crouching reach is measured from the lowered eye", () => {
  const { bot, target } = sceneWith(new Vec3(0, 64, 0), { name: "zombie", width: 0.6, height: 1.95, position: new Vec3(2, 68, 0) });
  assert.ok(meleeDistance(bot, target) < 3);
  Reflect.set(bot.entity, "eyeHeight", 1.27);
  assert.ok(meleeDistance(bot, target) > 3);
});

test("the native jumping large cube remains in body reach after its feet leave reach", () => {
  const { metadata, sized } = cubeSize("magma_cube");
  const { bot, target } = sceneWith(new Vec3(196.14653027997883, 49, -19.502752032458538), {
    name: "magma_cube",
    width: 0.52,
    height: 0.52,
    metadata,
    position: new Vec3(198.37265209484988, 53.10662108659744, -18.33239604547452),
  });
  sized(bot, 4);
  assert.ok(target.position.distanceTo(bot.entity.position) > 3);
  assert.deepEqual(entityDimensions(bot, target), { width: 2.08, height: 2.08 });
  assert.ok(meleeDistance(bot, target) < 3);
  target.position.y += 4;
  assert.ok(meleeDistance(bot, target) > 3, "a cube above actual reach is not swung at");
});

test("cube dimensions follow server size changes while ordinary mobs retain their observed body", () => {
  for (const name of ["slime", "magma_cube"] as const) {
    const { metadata, sized } = cubeSize(name);
    const { bot, target } = sceneWith(new Vec3(0, 64, 0), { name, width: 0.52, height: 0.52, metadata, position: new Vec3(3, 64, 0) });
    for (const size of [4, 2, 1]) {
      sized(bot, size);
      assert.deepEqual(entityDimensions(bot, target), { width: 0.52 * size, height: 0.52 * size });
    }
  }
  const { bot, target: zombie } = sceneWith(new Vec3(0, 64, 0), { name: "zombie", width: 0.6, height: 1.95, position: new Vec3(3, 64, 0) });
  assert.deepEqual(entityDimensions(bot, zombie), { width: 0.6, height: 1.95 });
});

test("approach arrival agrees with attack reach above and below a ledge", () => {
  const { metadata, sized } = cubeSize("magma_cube");
  const { bot, world: cells, target } = sceneWith(new Vec3(0, 63, 0), { name: "magma_cube", width: 0.52, height: 0.52, metadata, position: new Vec3(1, 61, 0) });
  const world = flatWorld();
  // The reach cases above the ledge must have observed air above them too.
  for (let x = -2; x <= 2; x++)
    for (let z = -2; z <= 2; z++) for (let y = 66; y <= 70; y++) world.load({ x, y, z }, { stateId: 0 });
  for (const [size, y, reachable] of [
    [1, 61, false],
    [4, 61, true],
    [4, 67, true],
    [4, 68, false],
  ] as const) {
    sized(bot, size);
    target.position.y = y;
    // The cube stands on the ledge: a block under it, so it is not read as a jumping cube.
    cells.setCell(new Vec3(1, y - 1, 0), "stone");
    const goal = meleeApproachGoal(bot, target.id, world).resolve({
      ...observation(),
      position: bot.entity.position,
    });
    assert.equal(goal.kind, "active");
    if (goal.kind !== "active") continue;
    assert.equal(
      goal.isSatisfied({ feet: { x: 0, y: 63, z: 0 }, remainingScaffolds: 0, overlayId: "overlay:0" }, goalTestWorld),
      reachable,
    );
    assert.equal(meleeDistance(bot, target) <= 3, reachable);
  }
});

test("melee arrival below a ceiling requires an exposed body, not just short eye distance", () => {
  const world = flatWorld();
  for (let x = -3; x <= 3; x++)
    for (let z = -3; z <= 3; z++) for (let y = 65; y <= 69; y++) world.load({ x, y, z }, { stateId: y === 65 ? 1 : 0 });
  const { bot, target } = sceneWith(new Vec3(0.6, 63, 0.5), { name: "skeleton", width: 0.6, height: 1.99, position: new Vec3(1.2, 67, 1.6) });
  const goal = meleeApproachGoal(bot, TARGET_ID, world).resolve({ ...observation(), position: bot.entity.position });
  assert.equal(goal.kind, "active");
  if (goal.kind !== "active") return;
  const node = { feet: { x: 0, y: 63, z: 0 }, remainingScaffolds: 0, overlayId: "overlay:0" };
  assert.ok(meleeDistance(bot, target) < 3);
  assert.equal(goal.isSatisfied(node, goalTestWorld), false);
  for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) world.load({ x, y: 65, z }, { stateId: 0 });
  assert.equal(
    goal.isSatisfied(node, goalTestWorld),
    true,
    "removing the intervening ceiling exposes the same body in reach",
  );
});

test("melee stance rejects an outward lava landing and accepts a supported side stance", () => {
  const world = flatWorld();
  for (let x = -5; x <= 5; x++)
    for (let z = -5; z <= 0; z++)
      world.load({ x, y: 62, z }, { stateId: 2, traits: { liquid: "lava", damaging: true } });
  const target = { x: 0.5, y: 63, z: 3.5 };
  assert.equal(hasMeleeKnockbackRoom(world, { x: 0.5, y: 63, z: 1.5 }, target), false);
  assert.equal(hasMeleeKnockbackRoom(world, { x: -0.5, y: 63, z: 3.5 }, target), true);
});

test("a full wall can catch knockback but a one-block lip cannot replace landing ground", () => {
  const world = flatWorld();
  world.load({ x: 0, y: 62, z: -1 }, { stateId: 0 });
  world.load({ x: 0, y: 63, z: -1 }, { stateId: 1 });
  const from = { x: 0.5, y: 63, z: 0.5 };
  const target = { x: 0.5, y: 63, z: 2.5 };
  assert.equal(hasMeleeKnockbackRoom(world, from, target), false);
  world.load({ x: 0, y: 64, z: -1 }, { stateId: 1 });
  assert.equal(hasMeleeKnockbackRoom(world, from, target), true);
});
