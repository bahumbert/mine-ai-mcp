import assert from "node:assert/strict";
import test from "node:test";
import type { Entity } from "prismarine-entity";
import { Vec3 } from "vec3";
import { type FakeEntitySpec, createFakeBot } from "../test-support/fake-bot/index.js";
import {
  cloudExposure,
  dragonDanger,
  incomingDragonBodies,
  incomingDragonFireballs,
  observeDragonEscape,
  perchedDragonContact,
  readDragonCloudHazards,
  readDragonClouds,
} from "./dragon-hazards.js";
import { dragonPhase, entityHealth, perchAttackCell, perchedDragonHead, perchedDragonBodyParts } from "./end-fight.js";

/** The entity's metadata slots: Prismarine types them as objects, while the game keeps numbers and flags there too. */
const metadataOf = (entity: Entity): unknown[] => entity.metadata;

/** One observed dragon, by its id on the bot. Phase 5 is the perch; 6 and 7 are the breath sequence. */
function dragonEntity(fields: { position?: Vec3; velocity?: Vec3; phase?: number; health?: number } = {}): FakeEntitySpec {
  const metadata: unknown[] = [];
  metadata[9] = fields.health ?? 200;
  metadata[16] = fields.phase ?? 5;
  return {
    name: "ender_dragon",
    position: fields.position ?? new Vec3(0, 68, 0),
    velocity: fields.velocity ?? new Vec3(0, 0, 0),
    yaw: 0,
    metadata,
  };
}

/** One area-effect cloud, of the dragon's breath unless another type is named. */
function cloudEntity(position: Vec3, radius: number, type = "dragon_breath"): FakeEntitySpec {
  const metadata: unknown[] = [];
  metadata[8] = radius;
  metadata[10] = { type };
  return { name: "area_effect_cloud", position, metadata };
}

/** A bot that sees the named entities from `feet`, standing on a floor at y 63. */
function endBot(entities: Record<number, FakeEntitySpec>, feet = new Vec3(0, 64, 0)) {
  return createFakeBot({ position: feet, entities });
}

test("1.21.4 Mineflayer dragon particle names identify breath without classifying potion clouds", () => {
  const { bot } = endBot({
    2: cloudEntity(new Vec3(2, 64, 3), 5),
    3: cloudEntity(new Vec3(2, 64, 3), 5, "entity_effect"),
  });
  assert.deepEqual(readDragonClouds(bot), [{ id: 2, x: 2, y: 64, z: 3, radius: 5 }]);
});

test("breath is a short cylinder: overhead and underground bodies are outside it", () => {
  const cloud = { id: 1, x: 0, y: 64, z: 0, radius: 5 };
  assert.ok(cloudExposure(cloud, { x: 0, y: 64, z: 0 }) > 0);
  assert.ok(cloudExposure(cloud, { x: 5.2, y: 64, z: 0 }) > 0);
  assert.equal(cloudExposure(cloud, { x: 5.4, y: 64, z: 0 }), 0);
  assert.equal(cloudExposure(cloud, { x: 0, y: 65, z: 0 }), 0);
  assert.equal(cloudExposure(cloud, { x: 0, y: 62, z: 0 }), 0);
  assert.ok(cloudExposure(cloud, { x: 0, y: 62, z: 0 }, 1.3) > 0, "a jump can enter a cloud above a safe landing cell");
  assert.equal(cloudExposure(cloud, { x: 0, y: 60, z: 0 }, 1.3), 0);
});

test("the multipart adapter is perch-only and never mutates the observed dragon", () => {
  const { bot } = createFakeBot({ entities: { 50: dragonEntity({ phase: 6, health: 123 }) } });
  const dragon = bot.entities[50]!;
  assert.equal(dragonPhase(bot, dragon), 6);
  assert.equal(entityHealth(bot, dragon), 123);
  const head = perchedDragonHead(bot, dragon)!;
  assert.equal(head.id, 51);
  assert.deepEqual(head.position, new Vec3(0, 67, 6.5));
  assert.deepEqual(dragon.position, new Vec3(0, 68, 0));
  metadataOf(dragon)[16] = 0;
  assert.equal(perchedDragonHead(bot, dragon), null);
});

test("fractional native perches keep the attack stance inside reach and below contact", () => {
  for (const y of [65, 65.01, 65.5, 65.99, 66]) {
    const head = new Vec3(6.25, y, -1.4);
    const cell = perchAttackCell(head);
    const feet = new Vec3(cell.x + 0.5, cell.y, cell.z + 0.5);
    assert.ok(feet.offset(0, 1.62, 0).distanceTo(head) < 2.7, `head at ${y} remains reachable`);
    assert.ok(feet.y + 1.8 < head.y - 1, `body at ${y} stays below the inflated head box`);
  }
});

test("breath escape must not finish in a perched dragon's wings", () => {
  const { bot } = endBot({ 42: dragonEntity({ phase: 5 }) });
  assert.equal(perchedDragonContact(bot, new Vec3(4.5, 65, 0)), true);
  assert.equal(perchedDragonContact(bot, new Vec3(4.5, 64, 0)), false);
  assert.equal(perchedDragonContact(bot, new Vec3(20, 65, 0)), false);
});

test("escape search freezes the moving dragon geometry and revises the next question", () => {
  // No loaded floor: the fountain scan finds nothing, and no breath cloud has a floor to lie on.
  const { bot } = createFakeBot({
    dimension: "the_end",
    groundY: null,
    entities: { 42: dragonEntity({ phase: 3 }) },
    overrides: { findBlocks: () => [] },
  });
  const dragon = bot.entities[42]!;
  const feet = new Vec3(0, 64, 0);
  const landing = observeDragonEscape(bot);
  assert.equal(landing.clearAt(feet), false);
  assert.equal(observeDragonEscape(bot).revision, landing.revision);
  dragon.position.y = 95;
  const high = observeDragonEscape(bot);
  assert.notEqual(high.revision, landing.revision);
  assert.equal(high.clearAt(feet), true);
  assert.equal(landing.clearAt(feet), false, "a running search must retain its original question");
  dragon.position.y = 68;
  metadataOf(dragon)[16] = 5;
  const perched = observeDragonEscape(bot);
  assert.notEqual(perched.revision, landing.revision);
  assert.equal(perched.clearAt(feet), true, "a low stance becomes available when the dragon settles");
});

test("a turning landing keeps the observed fountain unsafe until touchdown, while its low preparation remains usable", () => {
  const cells: Record<string, string> = {};
  for (const y of [64, 65, 66, 67]) cells[`0,${y},0`] = "bedrock";
  for (const [x,z] of [[3,0],[-3,0],[0,3],[0,-3]]) cells[`${x},64,${z}`] = "bedrock";
  let searches = 0;
  const { bot } = createFakeBot({ dimension: "the_end", cells, groundY: null,
    entities: { 42: dragonEntity({ phase: 3,
      position: new Vec3(6.3562760472, 77.4175431549, -3.9749171007),
      velocity: new Vec3(-0.0435, -0.146, 0.010875),
    }) },
    position: new Vec3(-1.5005339895, 65, 3.5410921273),
    overrides: { findBlocks: () => { searches++; return [new Vec3(0,64,0)]; } },
  });
  const dragon = bot.entities[42]!;
  for (const [x,y,z] of [[6.356,77.418,-3.975],[5.899,76.946,-3.881],[3.206,68.741,-2.180]]) {
    dragon.position.set(x!,y!,z!);
    const geometry = observeDragonEscape(bot);
    assert.equal(incomingDragonBodies(bot).length, 1, "the escape owner must keep moving until clear");
    assert.equal(geometry.clearAt(new Vec3(-1.7,65,2.7)), false, "the original premature arrival is still under the landing");
    assert.equal(geometry.clearAt(new Vec3(-13,65,2.7)), true);
    assert.equal(geometry.clearAt(new Vec3(6.5,61,0.5)), true, "do not block low head preparation");
    assert.equal(geometry.contactAt(bot.entity.position), false, "future landing must not prohibit every adjacent escape step");
  }
  assert.equal(searches, 1, "reuse the observed indestructible fountain instead of scanning chunks every physics tick");
  dragon.position.set(0.37,68.44,-0.08);
  metadataOf(dragon)[16] = 6;
  assert.equal(observeDragonEscape(bot).clearAt(new Vec3(0.5,64,6.5)), true, "observed settled contact permits the actual low strike stance");
});

test("a newly launched dragon fireball is predicted using acceleration, with receding and side passes excluded", () => {
  const { bot } = endBot({ 7: { name: "dragon_fireball", position: new Vec3(0, 64.9, -30), velocity: new Vec3(0, 0, 0.1) } });
  const projectile = bot.entities[7]!;
  assert.equal(incomingDragonFireballs(bot).length, 1);
  projectile.velocity = new Vec3(0, 0, -0.1);
  assert.equal(incomingDragonFireballs(bot).length, 0);
  projectile.velocity = new Vec3(0, 0, 0.1);
  projectile.position.x = 8;
  assert.equal(incomingDragonFireballs(bot).length, 0);
});

test("a low charge is detected before contact, while a high flyover stays clear", () => {
  const { bot } = endBot({ 42: dragonEntity({ position: new Vec3(0, 68, -40), velocity: new Vec3(0, 0, 1), phase: 8 }) });
  const dragon = bot.entities[42]!;
  assert.equal(incomingDragonBodies(bot).length, 1);
  dragon.position.y = 90;
  assert.equal(incomingDragonBodies(bot).length, 0);
  dragon.position.y = 68;
  metadataOf(dragon)[16] = 5;
  assert.equal(incomingDragonBodies(bot).length, 0, "perched contact uses its own part geometry");
});

test("the observed roar warns of breath before any cloud exists and remains unsafe across warmup", () => {
  const { bot } = endBot({ 42: dragonEntity({ phase: 6 }), 43: cloudEntity(new Vec3(0, 64, 9), 5) }, new Vec3(0, 64, 9));
  const dragon = bot.entities[42]!;
  // The breath cloud is held back until the point where the bot sees it spawn.
  const cloud = bot.entities[43]!;
  delete bot.entities[43];
  assert.equal(dragonDanger(bot), false, "scanning is not yet a committed breath");
  metadataOf(dragon)[16] = 7;
  assert.equal(readDragonClouds(bot).length, 0);
  assert.equal(dragonDanger(bot), true, "roar must start escape before the cloud exists");
  const warning = observeDragonEscape(bot);
  assert.equal(warning.clearAt(bot.entity.position), false);
  assert.equal(warning.clearAt(new Vec3(0, 62, 9)), true, "the entire body can fit below the predicted cloud");
  assert.equal(warning.clearAt(new Vec3(20, 64, 9)), true);
  metadataOf(dragon)[16] = 5;
  assert.equal(dragonDanger(bot), true, "the phase transition must not release escape during cloud warmup");
  bot.entity.position.z = 2;
  assert.equal(dragonDanger(bot), true, "the estimate includes head-position uncertainty");
  bot.entities[43] = cloud;
  assert.equal(dragonDanger(bot), false, "an observed cloud replaces the estimate rather than duplicating it");
  delete bot.entities[43];
  bot.entity.position.z = 9;

  metadataOf(dragon)[16] = 6;
  assert.equal(dragonDanger(bot), false);
  assert.equal(warning.clearAt(bot.entity.position), false, "running searches retain their hazard snapshot");
});

test("native fireball growth keeps one planned radius while perched clouds keep head reach", () => {
  const { bot } = endBot({ 2: cloudEntity(new Vec3(0, 64, 0), 3) });
  const cloud = bot.entities[2]!;
  // Native DragonFireball sets radius 3, duration 600 and float growth (7-3)/600.
  const growth = Math.fround(4 / 600);
  for (let tick = 0; tick < 600; tick++) {
    assert.equal(readDragonCloudHazards(bot)[0]!.radius, 7);
    assert.equal(readDragonClouds(bot)[0]!.radius, metadataOf(cloud)[8]);
    metadataOf(cloud)[8] = Math.fround((metadataOf(cloud)[8] as number) + growth);
  }
  metadataOf(cloud)[8] = 5;
  assert.equal(readDragonCloudHazards(bot)[0]!.radius, 5);
});


test("perched body adapters preserve native IDs and orthogonal wing geometry", () => {
  const { bot } = endBot({ 42: dragonEntity({ phase: 6 }) });
  const dragon = bot.entities[42]!;
  dragon.yaw = Math.PI / 4;
  const parts = perchedDragonBodyParts(bot, dragon);
  assert.deepEqual(parts.map(p => p.id), [44, 45, 49, 50]);
  const [neck, body, wing] = parts;
  assert.equal(neck!.width, 3);
  assert.equal(body!.width, 5);
  assert.ok(Math.abs(wing!.position.minus(dragon.position).dot(new Vec3(Math.sin(dragon.yaw), 0, Math.cos(dragon.yaw)))) < 1e-10);
  assert.equal(dragon.name, "ender_dragon");
  metadataOf(dragon)[16] = 3;
  assert.deepEqual(perchedDragonBodyParts(bot, dragon), []);
});
