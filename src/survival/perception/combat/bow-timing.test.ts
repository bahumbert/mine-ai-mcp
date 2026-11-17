import assert from "node:assert/strict";
import test from "node:test";
import { createFakeBot, createFakeClock, itemOf, listenersAddedSince } from "../../../test-support/fake-bot/index.js";
import { serverTickPace } from "../../../world/server-tick-pace.js";
import { Vec3 } from "vec3";
import { bowReleaseInTicks, trackBowDraws } from "./bow-timing.js";
import { observeProjectileDefence } from "../../weapons/shield-facing.js";
import { assessBowWindow } from "../../weapons/bow-window.js";

for (const rate of [20, 10]) test(`observed draw release counts server ticks at ${rate} tps`, async () => {
  const { bot, clock, server, entities } = createFakeBot({ clock: createFakeClock({ mode: "mocked" }), server: { ticksPerSecond: rate },
    entities: { 5: { name: "skeleton", position: new Vec3(0, 64, 8), metadata: { 8: 0 } } } });
  using _timers = clock.install();
  const added = listenersAddedSince(bot);
  using pace = serverTickPace(bot);
  await clock.advance(4_000);
  const enemy = bot.entities[5]!;
  enemy.setEquipment(0, itemOf(bot.registry, "bow"));
  const tracker = trackBowDraws(bot);
  const age = bot.time.age, gameTime = server.gameTime;
  Reflect.set(enemy.metadata, 8, 1); bot.emit("entityUpdate", enemy);
  await clock.advance(1_000);
  assert.equal(server.gameTime - gameTime, rate);
  assert.equal(bot.time.age - age, rate === 20 ? 20 : 0);
  assert.equal(bowReleaseInTicks(bot, enemy), rate === 20 ? 0 : 10);
  Reflect.set(enemy.metadata, 8, 0); bot.emit("entityUpdate", enemy);
  Reflect.set(enemy.metadata, 8, 1); bot.emit("entityUpdate", enemy);
  await clock.advance(20_000 / rate - 1);
  assert.equal(bowReleaseInTicks(bot, enemy), 1);
  await clock.advance(1);
  assert.equal(bowReleaseInTicks(bot, enemy), 0);
  Reflect.set(enemy.metadata, 8, 0); bot.emit("entityUpdate", enemy);
  Reflect.set(enemy.metadata, 8, 1); bot.emit("entityUpdate", enemy);
  await clock.advance(1_000 / rate);
  assert.equal(bowReleaseInTicks(bot, enemy), 19);
  // Replace the client object without a gone event: identity must reject the earlier live mark.
  delete bot.entities[5];
  const replacement = entities.spawn({ id: 5, name: "skeleton", position: new Vec3(0, 64, 8), metadata: { 8: 1 } });
  replacement.setEquipment(0, itemOf(bot.registry, "bow"));
  bot.emit("entityUpdate", replacement);
  assert.equal(bowReleaseInTicks(bot, enemy), null);
  assert.equal(bowReleaseInTicks(bot, replacement), null, "an already-active replacement has unknown draw age");
  Reflect.set(replacement.metadata, 8, 0); bot.emit("entityUpdate", replacement);
  Reflect.set(replacement.metadata, 8, 1); bot.emit("entityUpdate", replacement);
  assert.equal(bowReleaseInTicks(bot, replacement), 20);
  bot.emit("respawn");
  assert.equal(bowReleaseInTicks(bot, replacement), null);
  await clock.advance(1_000 / rate);
  assert.equal(bowReleaseInTicks(bot, replacement), null, "respawn cannot restart the active draw");
  Reflect.set(replacement.metadata, 8, 0); bot.emit("entityUpdate", replacement);
  Reflect.set(replacement.metadata, 8, 1); bot.emit("entityUpdate", replacement);
  assert.equal(bowReleaseInTicks(bot, replacement), 20);
  entities.remove(5);
  assert.equal(bowReleaseInTicks(bot, replacement), null);
  const last = entities.spawn({ id: 5, name: "skeleton", position: new Vec3(0, 64, 8), metadata: { 8: 0 } });
  last.setEquipment(0, itemOf(bot.registry, "bow")); bot.emit("entityUpdate", last);
  Reflect.set(last.metadata, 8, 1); bot.emit("entityUpdate", last);
  assert.equal(bowReleaseInTicks(bot, last), 20);
  tracker[Symbol.dispose](); pace[Symbol.dispose]();
  assert.equal(bowReleaseInTicks(bot, last), null);
  await clock.advance(6_000);
  assert.equal(bowReleaseInTicks(bot, last), null);
  for (const event of ["time", "physicsTick", "entityUpdate", "entityGone", "respawn"]) assert.equal(added(event), 0);
});

for (const rate of [20, 10]) for (const noAge of [false, true]) test(`cold ${noAge ? "no-age" : "cached-age"} draw cannot open a late window at ${rate} tps`, async () => {
  const { bot, clock, server } = createFakeBot({ clock: createFakeClock({ mode: "mocked" }), server: { ticksPerSecond: rate, timePacketYet: !noAge },
    position: new Vec3(0, 64, 0), entities: { 5: { name: "skeleton", kind: "Hostile mobs", position: new Vec3(0, 64, 19.2), metadata: { 8: 0 }, headYaw: 0 } } });
  using _timers = clock.install();
  bot.world.raycast = () => null;
  using _pace = serverTickPace(bot);
  using _tracker = trackBowDraws(bot);
  const gameTime = server.gameTime;
  const enemy = bot.entities[5]!;
  enemy.setEquipment(0, itemOf(bot.registry, "bow"));
  Reflect.set(enemy.metadata, 8, 1); bot.emit("entityUpdate", enemy);
  await clock.advance(20_000 / rate);
  assert.equal(server.gameTime - gameTime, 20);
  assert.equal(bot.time.age, gameTime + 20);
  if (noAge) assert.equal(bowReleaseInTicks(bot, enemy), null, "a no-age start never becomes a fresh draw");
  else assert.equal(bowReleaseInTicks(bot, enemy), 19, "the first packet credits just one conservative tick");
  const window = assessBowWindow(observeProjectileDefence(bot), 20);
  assert.equal(window.safe, false);
  assert.equal(window.reason, "uncertain_timing");
});

test("observed draw transitions rank the due shooter ahead of entity order and survive lost sight", async () => {
  const enemy = (z: number) => ({ name: "skeleton", kind: "Hostile mobs", position: new Vec3(0, 64, z), metadata: { 8: 0 }, headYaw: z > 0 ? 0 : Math.PI });
  const { bot, clock } = createFakeBot({ clock: createFakeClock({ mode: "mocked" }), position: new Vec3(0, 64, 0), entities: { 5: enemy(8), 6: enemy(-8) } });
  using _timers = clock.install();
  using _pace = serverTickPace(bot);
  await clock.advance(4_000);
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
