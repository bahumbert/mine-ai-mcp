import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import test from "node:test";
import { type FakeEntitySpec, createFakeBot } from "../../../test-support/fake-bot/index.js";
import { CombatPerception } from "./observations.js";

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

test("perception caches exposure per tick, retains a distant actual attacker and releases connection listeners", () => {
  let rays = 0;
  const { bot } = createFakeBot({
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
  bot.emit("entityHurt", bot.entity, bot.entities[2]!);
  bot.emit("physicsTick");
  assert.equal(perception.read()[0]!.hasHitUs, true, "passive observation range does not forget an attacker");
  assert.equal(perception.read()[0]!.distance, 40);
  bot.emit("entityDead", bot.entities[2]!);
  assert.equal(perception.read().length, 0);
  bot.emit("entityGone", bot.entities[2]!);
  assert.equal(perception.attackerIds.size, 0);
  perception[Symbol.dispose]();
  assert.equal(bot.listenerCount("physicsTick"), 0);
  assert.equal(bot.listenerCount("entityHurt"), 0);
  assert.equal(bot._client.listenerCount("spawn_entity"), 0);
});

test("Enderman attack attribution follows the observed victim, not its anger flag", () => {
  const { bot } = createFakeBot({
    entities: {
      2: { name: "enderman", position: { x: 4.5, y: 64, z: 0.5 } },
      3: { name: "ender_dragon", position: { x: 4.5, y: 80, z: 20.5 } },
    },
  });
  using perception = new CombatPerception(bot);
  bot.emit("entityHurt", bot.entities[3]!, bot.entities[2]!);
  assert.equal(perception.attackerIds.has(2), false);
  bot.emit("entityHurt", bot.entity, bot.entities[2]!);
  assert.equal(perception.attackerIds.has(2), true);
  bot.emit("entityHurt", bot.entities[3]!, bot.entities[2]!);
  assert.equal(
    perception.attackerIds.has(2),
    false,
    "an observed attack on someone else retires its bot-target attribution",
  );
});
