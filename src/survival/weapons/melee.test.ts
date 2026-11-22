import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { MemoryWorld as GoalTestWorld } from "../../navigation/world/memory-world.js";
import { type FakeEntitySpec, createFakeBot } from "../../test-support/fake-bot/index.js";
import { addItemsToServerTag } from "../../test-support/datapack-tags.js";
import { flatWorld, observation } from "../../test-support/navigation.js";
import { entityDimensions } from "../../world/entity-dimensions.js";
import { combatItemsForTarget, hasMeleeKnockbackRoom, meleeApproachGoal, meleeDistance, waitingForDescendingBody } from "./melee.js";

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

/** The flat world with open cells observed up to y 80 over x,z -5..5, so a body can hover anywhere over it. */
function openSkyWorld() {
  const world = flatWorld();
  for (let x = -5; x <= 5; x++)
    for (let z = -5; z <= 5; z++) for (let y = 66; y <= 80; y++) world.load({ x, y, z }, { stateId: 0 });
  return world;
}

/** The bot at feet (0,64,0), its eye 65.62, and `body` as entity 7: `waitingForDescendingBody` for it over `world`. */
function waitsUnder(world: GoalTestWorld, body: { name: string; width: number; height: number; position: Vec3 }) {
  const { bot, target } = sceneWith(new Vec3(0, 64, 0), body);
  return waitingForDescendingBody(bot, world, target);
}

const BLAZE = { name: "blaze", width: 0.5, height: 1.8 } as const;

test("a body over open cells waits for descent only above the bot's feet, above reach and within the horizontal gap", () => {
  const world = openSkyWorld();
  // Reach is 3 from the eye (65.62) to the body's underside; width 0.5 makes the gap x - 0.25, exact in binary.
  for (const [x, y, waits, why] of [
    [0, 68.6, false, "2.98 from the eye: in reach, swung at, not waited for"],
    [0, 68.7, true, "3.08 from the eye: above reach"],
    [3.25, 72, true, "gap 3.0"],
    [3.35, 72, false, "gap 3.1: the bot would walk under it, not hold"],
    [1, 64, false, "at the feet"],
    [1, 63, false, "below the feet"],
    // Accepted: the hold is bounded by the fight's quarry clock, not by the body's height.
    [1, 77, true, "12 above the bot, within the horizontal gap"],
  ] as const) assert.equal(waitsUnder(world, { ...BLAZE, position: new Vec3(x, y, 0) }), waits, why);
});

test("a body waits for descent only while no cell under its footprint holds it up or in liquid", () => {
  const stand = { ...BLAZE, position: new Vec3(1, 70, 0) };
  assert.equal(waitsUnder(openSkyWorld(), stand), true, "precondition: open cells under the footprint");
  const floored = openSkyWorld();
  floored.load({ x: 1, y: 69, z: 0 }, { stateId: 1 });
  assert.equal(waitsUnder(floored, stand), false, "a solid block under one footprint cell: it stands on a ledge");
  for (const liquid of ["water", "lava"] as const) {
    const wet = openSkyWorld();
    wet.load({ x: 1, y: 69, z: 0 }, { stateId: 0, traits: { liquid, damaging: liquid === "lava" } });
    assert.equal(waitsUnder(wet, stand), false, `${liquid} under the footprint: a swimming body is not hovering`);
  }
  assert.equal(waitsUnder(new GoalTestWorld(), stand), false, "cells never observed are not open: no hold on a guess");
});

test("a mob mid-jump or on a fence top counts as airborne; one on a floor above does not", () => {
  const zombie = { name: "zombie", width: 0.6, height: 1.95 } as const;
  // Accepted (review B3): the hold is bounded by the fight's quarry clock, so a jump or a fence top costs at most that wait.
  const jump = openSkyWorld();
  jump.load({ x: 1, y: 67, z: 0 }, { stateId: 1 });
  assert.equal(waitsUnder(jump, { ...zombie, position: new Vec3(1, 69, 0) }), true, "feet 1 above a floor, 5 above the bot, one block off: mid-jump");
  const standing = openSkyWorld();
  standing.load({ x: 1, y: 67, z: 0 }, { stateId: 1 });
  assert.equal(waitsUnder(standing, { ...zombie, position: new Vec3(1, 68, 0) }), false, "feet on a floor 4 above the bot: supported");
  const fence = openSkyWorld();
  fence.load({ x: 1, y: 68, z: 0 }, { stateId: 1, collisionShapes: [{ minX: 0.375, minY: 0, minZ: 0.375, maxX: 0.625, maxY: 1.5, maxZ: 0.625 }] });
  assert.equal(waitsUnder(fence, { ...zombie, position: new Vec3(1, 69.5, 0) }), true, "a fence top: its feet are 1.5 above the block, the cell under them is open");
});

test("a cube's approach goal answers the same with and without hovering", () => {
  const { metadata, sized } = cubeSize("magma_cube");
  const { bot, world: cells, target } = sceneWith(new Vec3(0, 63, 0), { name: "magma_cube", width: 0.52, height: 0.52, metadata, position: new Vec3(1, 67, 0) });
  sized(bot, 4);
  const world = openSkyWorld();
  const node = { feet: { x: 0, y: 63, z: 0 }, remainingScaffolds: 0, overlayId: "overlay:0" };
  // A cube standing on a ledge (4: block under it) is not flattened, in reach at 67 and not at 68; a hopping one (no block) is flattened.
  for (const [y, ledge, reachable] of [[67, true, true], [68, true, false], [68, false, true]] as const) {
    target.position.y = y;
    cells.setCell(new Vec3(1, y - 1, 0), ledge ? "stone" : "air");
    world.load({ x: 1, y: y - 1, z: 0 }, { stateId: ledge ? 1 : 0 });
    for (const hovering of [false, true]) {
      const goal = meleeApproachGoal(bot, TARGET_ID, world, undefined, { hovering }).resolve({ ...observation(), position: bot.entity.position });
      assert.equal(goal.kind, "active");
      if (goal.kind === "active") assert.equal(goal.isSatisfied(node, goalTestWorld), reachable, `cube at y ${y}, ${ledge ? "on a ledge" : "hopping"}, hovering ${hovering}`);
    }
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

/** A zombie target two blocks away and, with `bystander`, a piglin beside it, a bot carrying `carried`. */
function sweepScene(carried: Record<string, number>, bystander: boolean, datapackSwords: readonly string[] = []) {
  const body = { width: 0.6, height: 1.95 };
  const entities: Record<number, FakeEntitySpec> = { [TARGET_ID]: { name: "zombie", position: new Vec3(2, 64, 0), ...body } };
  if (bystander) entities[8] = { name: "piglin", position: new Vec3(1, 64, 1), ...body };
  const harness = createFakeBot({ position: new Vec3(0, 64, 0), carried, entities });
  if (datapackSwords.length > 0) addItemsToServerTag(harness, "swords", datapackSwords);
  return { bot: harness.bot, target: harness.bot.entities[TARGET_ID]! };
}

test("with a bystander in sweep range, every vanilla sword is withheld and the other tools stay", () => {
  const carried = { wooden_sword: 1, stone_sword: 1, golden_sword: 1, iron_sword: 1, diamond_sword: 1, netherite_sword: 1, iron_axe: 1, iron_pickaxe: 1 };
  const { bot, target } = sweepScene(carried, true);
  assert.deepEqual(combatItemsForTarget(bot, target).map((item) => item.name).sort(), ["iron_axe", "iron_pickaxe"]);
});

test("with a bystander in sweep range, an item a datapack adds to swords is withheld", () => {
  const { bot, target } = sweepScene({ stick: 1, iron_pickaxe: 1 }, true, ["stick"]);
  assert.deepEqual(combatItemsForTarget(bot, target).map((item) => item.name), ["iron_pickaxe"]);
});

test("without a bystander every carried item stays, swords included", () => {
  const { bot, target } = sweepScene({ stick: 1, iron_sword: 1 }, false, ["stick"]);
  // `readCombatItems` lists the held item twice (hand, then inventory): the names, once each.
  assert.deepEqual([...new Set(combatItemsForTarget(bot, target).map((item) => item.name))].sort(), ["iron_sword", "stick"]);
});
