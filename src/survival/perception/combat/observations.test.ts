import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import test from "node:test";
import { type FakeEntitySpec, createFakeBot } from "../../../test-support/fake-bot/index.js";
import { CombatPerception } from "./observations.js";

/** A blaze's small fireball from 40 blocks (1 block a tick) lands after 41 server ticks (2050 ms: the flight rounds up, the aim point is 0.85 of the shooter and 0.7 of the bot); a killed creature leaves the client after its 945 ms death animation. */
const SMALL_FIREBALL_FLIGHT_MS = 2_100;
const DEATH_REMOVAL_MS = 1_000;
/** A second hurt of the same creature opens its hurt window again 10 server ticks after the first (`fake-bot-combat-rules.ts` HURT_WINDOW_TICKS). */
const SECOND_HURT_AFTER_MS = 500;
/** What the blaze's fireball costs the bot once it lands (the amount the harness passes on as final). */
const SMALL_FIREBALL_HIT = 3.5;

/** A new body the server announces under `id`: the same kind as an earlier one, a different object. */
function bodyOf(id: number, spec: FakeEntitySpec): Bot["entity"] {
  return createFakeBot({ entities: { [id]: spec } }).bot.entities[id]!;
}

test("only an observed blaze charge transition offers a first-shot window, spent even behind terrain", () => {
  const metadata: unknown[] = [];
  // A wall of stone across the line between the bot and the blaze's post: the charge is hidden behind terrain.
  const cells = Object.fromEntries([-1, 0, 1].flatMap((x) => [64, 65, 66].map((y) => [`${x},${y},-4`, "stone"])));
  const { bot } = createFakeBot({ position: { x: 0, y: 64, z: 0 }, cells, entities: { 2: { name: "blaze", position: { x: 0, y: 64, z: -8 }, metadata } } });
  const flags = bot.registry.entitiesByName.blaze!.metadataKeys!.indexOf("flags");
  const enemy = bot.entities[2]!;
  using perception = new CombatPerception(bot);
  const observe = () => {
    bot.emit("physicsTick");
    return perception.read()[0]!.firstShotInTicks;
  };
  assert.equal(observe(), null, "missing metadata is not an observed inactive charge");
  metadata[flags] = 1;
  assert.equal(observe(), null, "a flag first observed active may already be due");
  metadata[flags] = 0;
  assert.equal(observe(), null);
  metadata[flags] = 1;
  assert.equal(observe(), 60);
  for (let tick = 0; tick < 60; tick++) observe();
  assert.equal(observe(), 0, "hidden time does not renew the charge");
  enemy.position.z = -1;
  assert.equal(observe(), 0, "switching to melee does not clear the native flag");
  enemy.position.z = -8;
  assert.equal(observe(), 0);
  bot.entities[2] = bodyOf(2, { name: "blaze", position: enemy.position, metadata: [...metadata] });
  assert.equal(observe(), null, "entity-id reuse cannot inherit another body's observed charge start");
});

test("perception caches exposure per tick, retains a distant actual attacker and releases connection listeners", async () => {
  let rays = 0;
  const { bot, combat: scene, clock } = createFakeBot({
    position: { x: 0, y: 64, z: 0 },
    entities: { 2: { name: "blaze", position: { x: 0, y: 64, z: -8 } } },
  });
  const enemy = bot.entities[2]!;
  const raycast = bot.world.raycast;
  bot.world.raycast = (...ray) => {
    rays++;
    return raycast(...ray);
  };
  const perception = new CombatPerception(bot);
  const first = perception.read();
  assert.equal(rays, 0, "reading distances need not perform exposure work");
  assert.equal(first[0]!.visible, true);
  const performed = rays;
  assert.equal(first[0]!.lastSeenTick, 0);
  assert.equal(perception.read(), first);
  assert.equal(first[0]!.visible, true);
  assert.equal(rays, performed);
  enemy.position.z = -40;
  scene.shootBot("small_fireball", 2, SMALL_FIREBALL_HIT);
  await clock.advance(SMALL_FIREBALL_FLIGHT_MS);
  bot.emit("physicsTick");
  assert.equal(perception.read()[0]!.hasHitUs, true, "passive observation range does not forget an attacker");
  assert.equal(perception.read()[0]!.distance, 40);
  scene.kill(2);
  assert.equal(perception.read().length, 0);
  await clock.advance(DEATH_REMOVAL_MS);
  assert.equal(perception.attackerIds.size, 0);
  perception[Symbol.dispose]();
  assert.equal(bot.listenerCount("physicsTick"), 0);
  assert.equal(bot.listenerCount("entityHurt"), 0);
  assert.equal(bot._client.listenerCount("spawn_entity"), 0);
});

test("Enderman attack attribution follows the observed victim, not its anger flag", async () => {
  const { bot, combat: scene, clock } = createFakeBot({
    entities: {
      2: { name: "enderman", position: { x: 4.5, y: 64, z: 0.5 } },
      3: { name: "ender_dragon", position: { x: 4.5, y: 80, z: 20.5 } },
    },
  });
  using perception = new CombatPerception(bot);
  scene.hurt(3, 2, 1);
  assert.equal(perception.attackerIds.has(2), false);
  scene.hurtBot(1, 2);
  assert.equal(perception.attackerIds.has(2), true);
  await clock.advance(SECOND_HURT_AFTER_MS);
  scene.hurt(3, 2, 1);
  assert.equal(
    perception.attackerIds.has(2),
    false,
    "an observed attack on someone else retires its bot-target attribution",
  );
});
