import assert from "node:assert/strict";
import test from "node:test";
import { createFakeBot, entityBodyOf } from "../../../test-support/fake-bot/index.js";
import { CombatPerception } from "./observations.js";

/** A blaze's small fireball from 40 blocks (1 block a tick) lands after 41 server ticks (2050 ms: the flight rounds up, the aim point is 0.85 of the shooter and 0.7 of the bot); a killed creature leaves the client after its 945 ms death animation. */
const SMALL_FIREBALL_FLIGHT_MS = 2_100;
const DEATH_REMOVAL_MS = 1_000;
/** A second hurt of the same creature opens its hurt window again 10 server ticks after the first (`fake-bot-combat-rules.ts` HURT_WINDOW_TICKS). */
const SECOND_HURT_AFTER_MS = 500;
/** What the blaze's fireball costs the bot once it lands (the amount the harness passes on as final). */
const SMALL_FIREBALL_HIT = 3.5;

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
  bot.entities[2] = entityBodyOf(2, { name: "blaze", position: enemy.position, metadata: [...metadata] });
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

// The two ways a shooter's shot is observed: an arrow's hit (`damage_event`: the fake attributes an arrow when it lands, 11 ticks
// from 17 blocks at 1.6 a tick = 550 ms, before the next time packet at ~1 s) and a blaze's own small fireball spawn
// (`spawn_entity` with the blaze as `objectData`, the one projectile spawn that names its owner: `projectile-spawn.ts`).
const SHOT_SOURCES = [
  { name: "an arrow's hit", shooter: "skeleton",
    fire: async ({ combat, clock }: ReturnType<typeof createFakeBot>) => { combat.shootBot("arrow", 2, 1); await clock.advance(700); } },
  { name: "a blaze's small fireball spawn", shooter: "blaze",
    fire: async ({ bot, clock }: ReturnType<typeof createFakeBot>) => {
      bot._client.emit("spawn_entity", { entityId: 90, type: bot.registry.entitiesByName.small_fireball!.id, objectData: 2,
        velocity: { x: 0, y: 0, z: -8000 } });
      await clock.advance(50);
    } },
] as const;
for (const source of SHOT_SOURCES) for (const heard of [true, false]) {
  test(`${source.name} records the world age the bot ${heard ? "heard when it was observed" : "had heard: none, so null, with the tick kept"}`, async () => {
    const world = createFakeBot({
      position: { x: 0, y: 64, z: 0 }, server: { timePacketYet: heard },
      entities: { 2: { name: source.shooter, position: { x: 0, y: 64, z: -17 } } },
    });
    using perception = new CombatPerception(world.bot);
    const shot = () => perception.read().find((threat) => threat.id === 2)!;
    assert.equal(shot().lastShotAge, null, "no shot yet");
    assert.equal(shot().lastShotTick, null);
    const first = world.bot.time.age;
    await source.fire(world);
    assert.notEqual(shot().lastShotTick, null, "the shot was observed");
    assert.equal(shot().lastShotAge, heard ? first : null, "the age heard then");
    if (!heard) return;
    await world.clock.advance(1_300);
    assert.ok(world.bot.time.age! > first!, "the world age moved on");
    await source.fire(world);
    assert.equal(shot().lastShotAge, world.bot.time.age, "the next shot is at the age heard then");
  });
}

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

test("observed hit damage and intervals belong to one attacker and require continuous melee reach", async () => {
  const { bot, combat, clock } = createFakeBot({ entities: { 2: { name: "zombie", position: { x: 2.5, y: 64, z: 0.5 } } } });
  using perception = new CombatPerception(bot);
  combat.hurtBot(3, 2);
  assert.deepEqual(perception.observedHits(2), { damage: 3, intervalTicks: null });
  await clock.advance(1_000);
  combat.hurtBot(3, 2);
  assert.deepEqual(perception.observedHits(2), { damage: 3, intervalTicks: 20 });
  bot.entities[2]!.position.x = 10;
  await clock.advance(500);
  bot.entities[2]!.position.x = 2.5;
  await clock.advance(500);
  combat.hurtBot(3, 2);
  assert.deepEqual(perception.observedHits(2), { damage: 3, intervalTicks: null });
  await clock.advance(1_500);
  combat.hurtBot(3, 2);
  assert.equal(perception.observedHits(2).intervalTicks, 20, "an observation cannot lengthen the vanilla interval");
  bot.emit("entityGone", bot.entities[2]!);
  assert.deepEqual(perception.observedHits(2), { damage: null, intervalTicks: null });
});

test("ambiguous, sourceless and zero-drop hurts cannot be credited to a mob", () => {
  const { bot, combat } = createFakeBot({ entities: {
    2: { name: "zombie", position: { x: 2.5, y: 64, z: 0.5 } },
    3: { name: "skeleton", position: { x: 2.5, y: 64, z: 1.5 } },
  } });
  using perception = new CombatPerception(bot);
  // Packet shapes: damage-event-to-bot contract; Mineflayer entities.js:398-402.
  for (const sources of [[2], [2, 3], [2, null], [null]]) {
    for (const source of sources) bot.emit("entityHurt", bot.entity, bot.entities[source ?? -1]!);
    combat.setHealth(sources.length === 1 && sources[0] === 2 ? bot.health : bot.health - 1);
    assert.deepEqual(perception.observedHits(2), { damage: null, intervalTicks: null });
    assert.deepEqual(perception.observedHits(3), { damage: null, intervalTicks: null });
  }
});

test("observed damage includes absorption lost and is forgotten on respawn or dimension change", () => {
  const { bot, combat } = createFakeBot({ entities: { 2: { name: "zombie", position: { x: 2.5, y: 64, z: 0.5 } } } });
  const key = bot.registry.entitiesByName.player!.metadataKeys!.indexOf("player_absorption");
  Reflect.set(bot.entity.metadata, key, 4);
  using perception = new CombatPerception(bot);
  for (const reset of [() => bot.emit("respawn"), () => { bot.game.dimension = "the_nether"; }]) {
    // Metadata layout from minecraft-data; we exercise the reader boundary, not fake absorption mechanics.
    Reflect.set(bot.entity.metadata, key, 4);
    bot.emit("entityHurt", bot.entity, bot.entities[2]!);
    Reflect.set(bot.entity.metadata, key, 1);
    combat.setHealth(bot.health);
    assert.deepEqual(perception.observedHits(2), { damage: 3, intervalTicks: null });
    reset();
    assert.deepEqual(perception.observedHits(2), { damage: null, intervalTicks: null });
  }
});

test("ambiguous hurts break the interval evidence between an attacker's known hits", async () => {
  const { bot, combat, clock } = createFakeBot({ entities: {
    2: { name: "zombie", position: { x: 2.5, y: 64, z: 0.5 } },
    3: { name: "skeleton", position: { x: 2.5, y: 64, z: 1.5 } },
  } });
  using perception = new CombatPerception(bot);
  combat.hurtBot(3, 2);
  await clock.advance(600);
  for (const id of [2, 3]) bot.emit("entityHurt", bot.entity, bot.entities[id]!);
  combat.setHealth(14);
  assert.equal(perception.observedHits(2).damage, 3, "an ambiguous update does not replace the known cost");
  await clock.advance(600);
  combat.hurtBot(3, 2);
  assert.deepEqual(perception.observedHits(2), { damage: 3, intervalTicks: null }, "the old and new known hits need not be consecutive");
});

test("pending hit attribution cannot cross removal, body replacement, respawn or a dimension change", () => {
  for (const transition of ["removal", "replacement", "respawn", "dimension"] as const) {
    const { bot, combat, entities } = createFakeBot({ entities: { 2: { name: "zombie", position: { x: 2.5, y: 64, z: 0.5 } } } });
    using perception = new CombatPerception(bot);
    bot.emit("entityHurt", bot.entity, bot.entities[2]!);
    if (transition === "removal") entities.remove(2);
    if (transition === "replacement") bot.entities[2] = entityBodyOf(2, { name: "zombie", position: { x: 2.5, y: 64, z: 0.5 } });
    if (transition === "respawn") bot.emit("respawn");
    if (transition === "dimension") bot.game.dimension = "the_nether";
    combat.setHealth(17);
    assert.deepEqual(perception.observedHits(2), { damage: null, intervalTicks: null }, transition);
  }
});
