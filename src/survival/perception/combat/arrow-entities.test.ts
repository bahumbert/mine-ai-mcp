/** Which entities count as arrows in flight and as tracked projectiles: the entity families, never entity names. */
import assert from "node:assert/strict";
import test from "node:test";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { projectileSnapshot } from "../../../diagnostics/projectile-snapshot.js";
import { addEntitiesToServerTag } from "../../../test-support/datapack-tags.js";
import { createFakeBot } from "../../../test-support/fake-bot/index.js";
import { arrowFlight, isArrowEntity, trackArrowFlights } from "./arrow-flight.js";
import { readProjectileSpawn } from "./projectile-spawn.js";
import { arrowImpact, incomingShieldProjectiles } from "./shield-projectiles.js";

const SHIPPED_VERSIONS = ["1.19.4", "1.20.1", "1.20.4", "1.20.6", "1.21.1", "1.21.4"] as const;

/** The packet the server sends to announce a projectile of registry entity `type`, thrown by entity `owner`. */
function spawnPacket(bot: Bot, entity: string, owner = 0) {
  return { entityId: 50, type: bot.registry.entitiesByName[entity]!.id, objectData: owner, velocity: { x: 0, y: 0, z: -8000 } };
}

// Cold registries must not share one test deadline under concurrent worker load (P4-06c T9b, 2026-11-08).
for (const version of SHIPPED_VERSIONS) {
  test(`the projectile spawn guard preserves arrow and blaze tracking and excludes snowballs, ${version}`, () => {
    const { bot } = createFakeBot({ version, entities: { 9: { name: "blaze", position: new Vec3(5, 64, 0) }, 10: { name: "zombie", position: new Vec3(6, 64, 0) } } });
    assert.deepEqual(readProjectileSpawn(bot, spawnPacket(bot, "arrow"))?.ownerId, null, `arrow ${version}`);
    assert.deepEqual(readProjectileSpawn(bot, spawnPacket(bot, "spectral_arrow"))?.ownerId, null, `spectral_arrow ${version}`);
    assert.equal(readProjectileSpawn(bot, spawnPacket(bot, "small_fireball", 9))?.ownerId, 9, `a blaze's small fireball keeps its owner ${version}`);
    assert.equal(readProjectileSpawn(bot, spawnPacket(bot, "small_fireball", 10)), null, `a small fireball nobody on a blaze threw ${version}`);
    assert.equal(readProjectileSpawn(bot, spawnPacket(bot, "snowball", 9)), null, `no snowball ${version}`);
  });
}

test("trident direction guarding handles lifecycle, terrain and movement; snowballs are excluded", () => {
  for (const [label, name, x, velocity, valid, allowance, wall, expected] of [
    ["incoming", "trident", 0.5, -1, true, 0, false, true],
    ["outgoing", "trident", 0.5, 1, true, 0, false, false],
    ["stationary", "trident", 0.5, 0, true, 0, false, false],
    ["removed", "trident", 0.5, -1, false, 0, false, false],
    ["miss", "trident", 1.5, -1, true, 0, false, false],
    ["movement allowance", "trident", 1.5, -1, true, 2, false, true],
    ["terrain", "trident", 0.5, -1, true, 0, true, false],
    ["snowball", "snowball", 0.5, -1, true, 0, false, false],
  ] as const) {
    const { bot, world } = createFakeBot({ groundY: null, entities: { 4: { name, position: new Vec3(x, 65, 8) } } });
    const shot = bot.entities[4]!;
    shot.velocity.set(0, 0, velocity);
    shot.isValid = valid;
    if (wall) world.setCell(new Vec3(0, 65, 4), "stone");
    assert.equal(incomingShieldProjectiles(bot, allowance).includes(shot), expected, label);
    if (expected) assert.equal(arrowImpact(bot, shot), null, "direction guarding does not infer arrow flight");
  }
});

test("an entity a datapack adds to entity tag `arrows` is tracked in flight, spawned and impacting like an arrow", () => {
  const harness = createFakeBot({ position: { x: 0, y: 64, z: 0 }, groundY: null, entities: { 4: { name: "snowball", position: { x: 0, y: 67.3, z: 8 } } } });
  const { bot } = harness;
  const entity = bot.entities[4]!;
  entity.velocity.set(0, 0, -1);
  assert.equal(isArrowEntity(bot, entity), false, "vanilla: a snowball is no arrow");
  assert.equal(readProjectileSpawn(bot, spawnPacket(bot, "snowball")), null);
  assert.equal(arrowImpact(bot, entity), null);
  assert.equal(projectileSnapshot(bot, entity), undefined);
  addEntitiesToServerTag(harness, "arrows", ["snowball"]);
  assert.equal(isArrowEntity(bot, entity), true, "the next question sees the server's new tag");
  assert.notEqual(readProjectileSpawn(bot, spawnPacket(bot, "snowball")), null);
  assert.notEqual(arrowImpact(bot, entity), null, "an incoming member of the family is a shield threat");
  assert.notEqual(projectileSnapshot(bot, entity), undefined);
  using _tracker = trackArrowFlights(bot, () => 0);
  bot._client.emit("spawn_entity", { entityId: 4 });
  assert.notEqual(arrowFlight(bot, entity, 0).positionAt, null, "the flight tracker anchored it on its spawn packet");
  assert.equal(isArrowEntity(bot, undefined), false, "no entity, no arrow");
  assert.equal(isArrowEntity(bot, { ...entity, name: undefined } as never), false, "an entity without a name is no arrow");
});
