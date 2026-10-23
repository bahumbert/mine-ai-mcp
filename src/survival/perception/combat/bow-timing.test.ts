import assert from "node:assert/strict";
import test from "node:test";
import { createFakeBot, itemOf } from "../../../test-support/fake-bot/index.js";
import { Vec3 } from "vec3";
import { bowReleaseInTicks, trackBowDraws } from "./bow-timing.js";
import { observeProjectileDefence } from "../../weapons/shield-facing.js";

test("observed draw transitions rank the due shooter ahead of entity order and survive lost sight", async () => {
  // Stopgap until M3 merges entity.kind: entities.js:184 sets `entity.kind = entityData.category`.
  const enemy = (z: number) => ({ name: "skeleton", kind: "Hostile mobs", position: new Vec3(0, 64, z), metadata: { 8: 0 }, headYaw: z > 0 ? 0 : Math.PI });
  const { bot, clock } = createFakeBot({ position: new Vec3(0, 64, 0), entities: { 5: enemy(8), 6: enemy(-8) } });
  bot.world.raycast = () => null;
  const later = bot.entities[5]!, sooner = bot.entities[6]!;
  for (const shooter of [later, sooner]) shooter.setEquipment(0, itemOf(bot.registry, "bow"));
  using _tracker = trackBowDraws(bot);
  Reflect.set(sooner.metadata, 8, 1); bot.emit("entityUpdate", sooner);
  await clock.advance(15 * 50);
  Reflect.set(later.metadata, 8, 1); bot.emit("entityUpdate", later);
  assert.equal(bowReleaseInTicks(bot, sooner), 5);
  assert.equal(bowReleaseInTicks(bot, later), 20);
  assert.equal(observeProjectileDefence(bot)!.windupForecasts[0]!.entity.id, 6);
  assert.ok(observeProjectileDefence(bot)!.facing.z < 0);
  await clock.advance(30 * 50);
  assert.equal(bowReleaseInTicks(bot, sooner), 0, "held draws do not start another timer");
  Reflect.set(sooner.metadata, 8, 0); bot.emit("entityUpdate", sooner);
  assert.equal(bowReleaseInTicks(bot, sooner), null);
});

test("a draw already active when observed has unknown age", async () => {
  const { bot, clock } = createFakeBot({ entities: { 5: { name: "skeleton", position: new Vec3(0.5, 64, 8.5), metadata: { 8: 1 } } } });
  const enemy = bot.entities[5]!;
  enemy.setEquipment(0, itemOf(bot.registry, "bow"));
  using _tracker = trackBowDraws(bot);
  assert.equal(bowReleaseInTicks(bot, enemy), null);
  await clock.advance(50);
  assert.equal(bowReleaseInTicks(bot, enemy), null);
});

test("equipment arriving after active metadata does not restart a draw", () => {
  const { bot } = createFakeBot({ entities: { 5: { name: "skeleton", position: new Vec3(0.5, 64, 8.5), metadata: { 8: 1 } } } });
  const enemy = bot.entities[5]!;
  using _tracker = trackBowDraws(bot);
  enemy.setEquipment(0, itemOf(bot.registry, "bow"));
  bot.emit("entityUpdate", enemy);
  assert.equal(bowReleaseInTicks(bot, enemy), null);
});
