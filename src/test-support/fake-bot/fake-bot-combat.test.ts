/**
 * The fake bot's fights beyond what the contract checks measure (`attack-hurts-and-kills`, `attack-cooldown-damage`,
 * `attack-out-of-reach`, `bow-draw-and-release`, `shield-raised`, `consume-food`, `damage-event-to-bot`, `explosion-knockback`):
 * the scene controls other actors use, a fight with a lagging or stopped server, and the next action from each end state.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { type FakeBotOptions, type FakeHarness, createFakeBot } from "./fake-bot.js";
import { itemOf } from "./fake-inventory.js";

const FEET = new Vec3(0.5, -60, 0.5);
const ZOMBIE_ID = 7;
const OTHER_ID = 8;

function fight(options: FakeBotOptions = {}): FakeHarness {
  return createFakeBot({
    position: FEET,
    slots: { 36: { name: "iron_sword" } },
    entities: { [ZOMBIE_ID]: { name: "zombie", position: new Vec3(0.5, -60, 2.5) }, [OTHER_ID]: { name: "zombie", position: new Vec3(-2.5, -60, 0.5) } },
    ...options,
  });
}

const healthOf = ({ bot }: FakeHarness, id: number) => Number(bot.entities[id]!.metadata[bot.registry.entitiesByName.zombie!.metadataKeys!.indexOf("health")]);

test("a mob hurt by another actor tells the bot who hurt it, and keeps its hurt window", async () => {
  const harness = fight();
  const hurts: { id: number; source: number | undefined }[] = [];
  harness.bot.on("entityHurt", (entity, source) => void hurts.push({ id: entity.id, source: source?.id }));
  harness.combat.hurt(ZOMBIE_ID, OTHER_ID, 3);
  harness.combat.hurt(ZOMBIE_ID, OTHER_ID, 3);
  await harness.clock.advance(100);
  assert.deepEqual(hurts, [{ id: ZOMBIE_ID, source: OTHER_ID }], "the second hurt came inside the window");
  assert.equal(healthOf(harness, ZOMBIE_ID), 17);
  await harness.clock.advance(500);
  harness.combat.hurt(ZOMBIE_ID, null, 3);
  assert.equal(hurts.length, 2);
  assert.equal(hurts[1]!.source, undefined, "a hurt with no source names none");
});

test("a swing of another entity is heard as entitySwingArm", () => {
  const harness = fight();
  const swung: number[] = [];
  harness.bot.on("entitySwingArm", (entity) => void swung.push(entity.id));
  harness.combat.swing(OTHER_ID);
  assert.deepEqual(swung, [OTHER_ID]);
});

test("a killed mob dies at once and leaves after its death animation; its drops lie where it stood and the bot picks them up", async () => {
  const harness = fight({ entities: { [ZOMBIE_ID]: { name: "zombie", position: new Vec3(0.5, -60, 0.5), drops: [{ name: "rotten_flesh", count: 2 }] } } });
  const heard: string[] = [];
  harness.bot.on("entityDead", () => void heard.push("dead"));
  harness.bot.on("entityGone", (entity) => void (entity.name === "zombie" && heard.push("gone")));
  harness.combat.kill(ZOMBIE_ID);
  assert.deepEqual(heard, ["dead"]);
  await harness.clock.advance(500);
  assert.deepEqual(heard, ["dead"], "the corpse is still there");
  await harness.clock.advance(1_000);
  assert.deepEqual(heard, ["dead", "gone"]);
  await harness.clock.advance(1_000);
  assert.equal(harness.inventory.count(harness.bot.registry.itemsByName.rotten_flesh!.id, null), 2, "the drop was picked up after its delay");
});

test("a hit on a mob removed between the swing and the server's answer hurts nothing and throws nothing", async () => {
  const harness = fight({ lagMs: 200 });
  const hurts: number[] = [];
  harness.bot.on("entityHurt", (entity) => void hurts.push(entity.id));
  harness.bot.attack(harness.bot.entities[ZOMBIE_ID]!);
  harness.entities.remove(ZOMBIE_ID);
  await harness.clock.advance(500);
  assert.deepEqual(hurts, []);
});

test("a stopped server answers no hit; the lagging one answers after its lag", async () => {
  const harness = fight({ lagMs: 200 });
  const hurts: number[] = [];
  harness.bot.on("entityHurt", (entity) => void hurts.push(entity.id));
  harness.server.stop();
  harness.bot.attack(harness.bot.entities[ZOMBIE_ID]!);
  await harness.clock.advance(1_000);
  assert.deepEqual(hurts, [], "a stopped server hurt the mob");
  harness.server.resume();
  await harness.clock.advance(100);
  assert.deepEqual(hurts, [ZOMBIE_ID]);
});

test("two mobs hit in turn each keep their own hurt window and health", async () => {
  const harness = fight();
  harness.bot.attack(harness.bot.entities[ZOMBIE_ID]!);
  harness.bot.attack(harness.bot.entities[OTHER_ID]!);
  await harness.clock.advance(200);
  assert.equal(healthOf(harness, ZOMBIE_ID), 14, "the first hit");
  // The second swing comes with no tick since the first: 6 x (0.2 + 0.8 x (0.5 / 12.5)^2) = 1.208 off its own full health.
  assert.ok(Math.abs(healthOf(harness, OTHER_ID) - 18.792) < 0.01, `the second mob has ${healthOf(harness, OTHER_ID)}`);
});

test("an unmeasured tool throws when it hits, naming how to measure it", async () => {
  const harness = fight({ slots: { 36: { name: "trident" } } });
  harness.bot.attack(harness.bot.entities[ZOMBIE_ID]!);
  await assert.rejects(harness.clock.advance(100), /does not know the damage of trident/u);
});

test("setHealth files health and food and ends in death once; a health above 0 after it spawns again", () => {
  const harness = fight();
  const heard: string[] = [];
  for (const event of ["health", "death", "spawn"] as const) harness.bot.on(event, () => void heard.push(event));
  harness.combat.setHealth(6, 12);
  assert.deepEqual([harness.bot.health, harness.bot.food], [6, 12]);
  harness.combat.setHealth(0);
  harness.combat.setHealth(0);
  harness.combat.setHealth(20);
  assert.deepEqual(heard, ["health", "health", "death", "health", "health", "spawn"]);
});

test("a bot hurt down to 2 health still hits: the next attack answers", async () => {
  const harness = fight();
  harness.combat.hurtBot(18, OTHER_ID);
  assert.equal(harness.bot.health, 2);
  harness.bot.attack(harness.bot.entities[ZOMBIE_ID]!);
  await harness.clock.advance(100);
  assert.equal(healthOf(harness, ZOMBIE_ID), 14);
});

test("a bot hurt to death hears her own death status, then dies once", () => {
  const harness = fight();
  const heard: string[] = [];
  harness.bot.on("entityDead", (entity) => void heard.push(`dead ${entity.id}`));
  harness.bot.on("death", () => void heard.push("death"));
  harness.combat.hurtBot(25, null);
  assert.deepEqual(heard, [`dead ${harness.bot.entity.id}`, "death"]);
  assert.equal(harness.bot.health, 0);
});

test("a hurt with no source pushes the bot nowhere", () => {
  const harness = fight();
  harness.combat.hurtBot(2, null);
  assert.equal(harness.bot.entity.velocity.x, 0);
});

test("a blast out of the creeper's reach pushes and hurts no one, the creeper still comes and goes", () => {
  const harness = fight();
  const names: string[] = [];
  harness.bot.on("entitySpawn", (entity) => void names.push(`+${entity.name}`));
  harness.bot.on("entityGone", (entity) => void names.push(`-${entity.name}`));
  harness.combat.explode(new Vec3(8.5, -60, 0.5));
  assert.deepEqual(names, ["+creeper", "-creeper"]);
  assert.equal(harness.bot.health, 20);
  assert.equal(harness.bot.entity.velocity.norm(), 0);
});

test("a bow's draw ends when the hand's item changes: the release after it shoots nothing", async () => {
  const harness = fight({ slots: { 36: { name: "bow" }, 37: { name: "iron_sword" }, 38: { name: "arrow", count: 8 } } });
  harness.bot.activateItem();
  await harness.clock.advance(600);
  harness.bot.setQuickBarSlot(1);
  await harness.clock.advance(100);
  harness.bot.setQuickBarSlot(0);
  harness.bot.deactivateItem();
  await harness.clock.advance(300);
  assert.equal(Object.values(harness.bot.entities).filter((entity) => entity.name === "arrow").length, 0);
  assert.equal(harness.inventory.count(harness.bot.registry.itemsByName.arrow!.id, null), 8);
});

test("a bow with no arrow behind it starts no draw", async () => {
  const harness = fight({ slots: { 36: { name: "bow" } } });
  harness.bot.activateItem();
  await harness.clock.advance(300);
  const flagsKey = harness.bot.registry.entitiesByName.player!.metadataKeys!.indexOf("living_entity_flags");
  assert.equal(Number(harness.bot.entity.metadata[flagsKey] ?? 0) & 1, 0);
});

test("a bigger hit inside the hurt window takes only its excess and tells the client nothing more", async () => {
  const harness = fight();
  const hurts: number[] = [];
  harness.bot.on("entityHurt", (entity) => void hurts.push(entity.id));
  harness.combat.hurt(ZOMBIE_ID, OTHER_ID, 2);
  harness.combat.hurt(ZOMBIE_ID, OTHER_ID, 5);
  await harness.clock.advance(100);
  assert.deepEqual(hurts, [ZOMBIE_ID]);
  assert.equal(healthOf(harness, ZOMBIE_ID), 15);
});

test("a mob killed twice dies once", () => {
  const harness = fight();
  const dead: number[] = [];
  harness.bot.on("entityDead", (entity) => void dead.push(entity.id));
  harness.combat.kill(ZOMBIE_ID);
  harness.combat.kill(ZOMBIE_ID);
  assert.deepEqual(dead, [ZOMBIE_ID]);
});

test("a creative bot is not hurt, and an unknown source is refused", () => {
  const creative = fight({ gameMode: "creative" });
  creative.combat.hurtBot(5, OTHER_ID);
  assert.equal(creative.bot.health, 20);
  assert.throws(() => fight().combat.hurtBot(2, 999), /no entity 999/u);
});

test("a bite of Mineflayer's own consume keeps usingHeldItem when another slot changes", async () => {
  const harness = fight({ slots: { 36: { name: "golden_apple", count: 2 } } });
  void harness.bot.consume().catch(() => undefined);
  await harness.clock.advance(100);
  harness.inventory.updateSlot(9, itemOf(harness.bot.registry, "dirt", 1));
  assert.equal(harness.bot.usingHeldItem, true);
});

test("a creature the fixture or the server spawns has its full health in its metadata, as the server's spawn data gives it", () => {
  const harness = fight();
  assert.equal(healthOf(harness, ZOMBIE_ID), 20);
  const spawned = harness.entities.spawn({ name: "zombie", position: new Vec3(3.5, -60, 0.5) });
  assert.equal(healthOf(harness, spawned.id), 20);
  const item = harness.entities.spawn({ name: "item", position: new Vec3(3.5, -60, 1.5), item: { name: "stone", count: 1 } });
  assert.equal(item.metadata[harness.bot.registry.entitiesByName.zombie!.metadataKeys!.indexOf("health")], undefined, "an item has no health");
});

/** A fireball 4.02 blocks off at 1 block a tick lands on the 5th tick. */
const FIREBALL_FLIGHT_MS = 250;
const SKELETON_ID = 9;
const BLAZE_ID = 10;
/** A skeleton 4 blocks east and a blaze 4 blocks west, the bot between them (the contract check `projectile-hit-bot`'s scene). */
function shooters(options: FakeBotOptions = {}): FakeHarness {
  return fight({ entities: { [ZOMBIE_ID]: { name: "zombie", position: new Vec3(0.5, -60, 2.5) }, [SKELETON_ID]: { name: "skeleton", position: new Vec3(4.5, -60, 0.5) }, [BLAZE_ID]: { name: "blaze", position: new Vec3(-3.5, -60, 0.5) } }, ...options });
}
const damageTypeOf = (harness: FakeHarness, name: string) => (harness.bot.registry as unknown as { loginPacket: { dimensionCodec: Record<string, { entries: { key: string }[] }> } }).loginPacket.dimensionCodec["minecraft:damage_type"]!.entries.findIndex(({ key }) => key === `minecraft:${name}`);

test("an arrow shot at the bot is heard spawning, then lands: damage_event naming the shooter and the arrow, the arrow gone, the health, a push a tick later", async () => {
  const harness = shooters();
  const heard: string[] = [];
  const damage: { sourceTypeId: number; sourceCauseId: number; sourceDirectId: number }[] = [];
  harness.bot._client.on("damage_event", (packet: (typeof damage)[number]) => void (heard.push("damage"), damage.push(packet)));
  harness.bot._client.on("entity_velocity", () => void heard.push("push"));
  harness.bot.on("entitySpawn", (entity) => void heard.push(`+${entity.name}`));
  harness.bot.on("entityGone", (entity) => void heard.push(`-${entity.name}`));
  harness.combat.shootBot("arrow", SKELETON_ID, 3);
  assert.deepEqual(heard, ["+arrow"], "the arrow is in the air first");
  const arrow = Object.values(harness.bot.entities).find(({ name }) => name === "arrow")!;
  await harness.clock.advance(200);
  assert.deepEqual(heard, ["+arrow", "damage", "-arrow", "push"]);
  assert.deepEqual(damage.map(({ sourceTypeId, sourceCauseId, sourceDirectId }) => ({ sourceTypeId, sourceCauseId, sourceDirectId })), [{ sourceTypeId: damageTypeOf(harness, "arrow"), sourceCauseId: SKELETON_ID + 1, sourceDirectId: arrow.id + 1 }]);
  assert.equal(harness.bot.health, 17);
  const push = harness.bot.entity.velocity;
  assert.ok(Math.abs(push.x - -0.2184) < 0.01 && Math.abs(push.y - 0.2752) < 0.01 && push.z === 0, `pushed ${push}`);
});

test("an arrow lands after the flight its distance and speed make: 4 blocks at 1.6 a tick is 3 ticks", async () => {
  const harness = shooters();
  harness.combat.shootBot("arrow", SKELETON_ID, 3);
  await harness.clock.advance(100);
  assert.equal(harness.bot.health, 20, "still flying after 2 ticks");
  await harness.clock.advance(100);
  assert.equal(harness.bot.health, 17);
});

test("a small fireball sets the bot on fire before it hurts her: 1 of on_fire damage at 1, 2, 3 and 4 s, the flag out at 5 s", async () => {
  const harness = shooters();
  const burns: number[] = [];
  const healths: number[] = [];
  const { clock, bot } = harness;
  const onFire = damageTypeOf(harness, "on_fire");
  bot._client.on("damage_event", (packet: { entityId: number; sourceTypeId: number }) => void (packet.entityId === bot.entity.id && packet.sourceTypeId === onFire && burns.push(clock.now())));
  bot.on("health", () => void healths.push(bot.health));
  const flagged = () => Number(bot.entity.metadata[0] ?? 0) & 1;
  const start = clock.now();
  harness.combat.shootBot("small_fireball", BLAZE_ID, 3.5);
  await clock.advance(FIREBALL_FLIGHT_MS);
  assert.equal(flagged(), 1, "burning");
  assert.equal(bot.health, 16.5);
  await clock.advance(4_550);
  assert.equal(flagged(), 1, "still burning 4.8 s after the hit");
  await clock.advance(500);
  assert.equal(flagged(), 0, "out 5.3 s after it");
  assert.deepEqual(burns.map((at) => at - start - FIREBALL_FLIGHT_MS), [1_000, 2_000, 3_000, 4_000]);
  assert.equal(bot.health, 12.5);
});

test("a second fireball while burning starts the five seconds over, and one inside the hurt window with less damage sets no fire and costs nothing", async () => {
  const harness = shooters();
  const { clock, bot } = harness;
  harness.combat.shootBot("small_fireball", BLAZE_ID, 3.5);
  await clock.advance(3_000);
  const healthBefore = bot.health;
  harness.combat.shootBot("small_fireball", BLAZE_ID, 3.5);
  await clock.advance(FIREBALL_FLIGHT_MS);
  assert.equal(bot.health, healthBefore - 3.5, "a fresh hit in full");
  await clock.advance(4_500);
  assert.equal(Number(bot.entity.metadata[0] ?? 0) & 1, 1, "burning past the first fire's end");
  await clock.advance(1_000);
  assert.equal(Number(bot.entity.metadata[0] ?? 0) & 1, 0);
  const quiet = shooters();
  quiet.combat.hurtBot(6, SKELETON_ID);
  quiet.combat.shootBot("small_fireball", BLAZE_ID, 3.5);
  await quiet.clock.advance(FIREBALL_FLIGHT_MS + 50);
  assert.equal(Number(quiet.bot.entity.metadata[0] ?? 0) & 1, 0, "a hit the window absorbs lights no fire");
  assert.equal(quiet.bot.health, 14, "and costs nothing");
  assert.equal(Object.values(quiet.bot.entities).filter(({ name }) => name === "small_fireball").length, 0, "the ball is gone all the same");
});

test("a shot at a bot that dies of it burns no more, and the next action from a bot shot to 2 health still runs", async () => {
  const harness = shooters();
  harness.combat.setHealth(3);
  harness.combat.shootBot("small_fireball", BLAZE_ID, 3.5);
  await harness.clock.advance(FIREBALL_FLIGHT_MS);
  assert.equal(harness.bot.health, 0);
  await harness.clock.advance(6_000);
  assert.equal(harness.bot.health, 0, "no burn after death");
  const alive = shooters();
  alive.combat.shootBot("arrow", SKELETON_ID, 17);
  await alive.clock.advance(300);
  assert.equal(alive.bot.health, 3);
  alive.bot.attack(alive.bot.entities[ZOMBIE_ID]!);
  await alive.clock.advance(100);
  assert.equal(healthOf(alive, ZOMBIE_ID), 14);
});

test("a shot from an unknown shooter is refused, a stopped server lets the arrow hang, a creative bot is not hurt and the arrow still goes", async () => {
  assert.throws(() => shooters().combat.shootBot("arrow", 999, 3), /no entity 999/u);
  const stopped = shooters();
  stopped.combat.shootBot("arrow", SKELETON_ID, 3);
  stopped.server.stop();
  await stopped.clock.advance(1_000);
  assert.equal(stopped.bot.health, 20);
  stopped.server.resume();
  await stopped.clock.advance(200);
  assert.equal(stopped.bot.health, 17);
  const creative = shooters({ gameMode: "creative" });
  creative.combat.shootBot("arrow", SKELETON_ID, 3);
  await creative.clock.advance(200);
  assert.equal(creative.bot.health, 20);
  assert.equal(Object.values(creative.bot.entities).filter(({ name }) => name === "arrow").length, 0);
});

/** The `entity_velocity` packets the client hears for `id` (raw, in notchian units) with the clock reading of each. */
function listenToVelocities(harness: FakeHarness, id: number) {
  const heard: { atMs: number; x: number; y: number; z: number }[] = [];
  harness.bot._client.on("entity_velocity", (packet: { entityId: number; velocity: { x: number; y: number; z: number } }) => void (packet.entityId === id && heard.push({ atMs: harness.clock.now(), ...packet.velocity })));
  return heard;
}

test("a hit by hand pushes a mob 0.4 away along the ground: its velocity twice, a tick after the hit, around its health", async () => {
  const harness = fight({ slots: {} });
  const velocities = listenToVelocities(harness, ZOMBIE_ID);
  const order: string[] = [];
  harness.bot._client.on("damage_event", () => void order.push("damage"));
  harness.bot._client.on("entity_velocity", (packet: { entityId: number }) => void (packet.entityId === ZOMBIE_ID && order.push("velocity")));
  harness.bot.on("entityUpdate", (entity) => void (entity.id === ZOMBIE_ID && order.push("health")));
  harness.bot.attack(harness.bot.entities[ZOMBIE_ID]!);
  await harness.clock.advance(50);
  assert.deepEqual(order, ["damage", "velocity", "health", "velocity"], "the hit, then the push and the health a tick later");
  assert.deepEqual(velocities.map(({ x, y, z }) => [x, y, z]), [[0, 0, 3200], [0, 0, 3200]]);
  assert.equal(harness.bot.entities[ZOMBIE_ID]!.velocity.z, 0.4, "Mineflayer files the velocity on the entity");
});

test("a mob's push decays by 0.98 a tick, told every 3 ticks, and ends with a velocity of zero; the mob never moves", async () => {
  const harness = fight({ slots: {} });
  const velocities = listenToVelocities(harness, ZOMBIE_ID);
  const moves: string[] = [];
  for (const packet of ["rel_entity_move", "entity_move_look", "entity_teleport", "sync_entity_position"]) harness.bot._client.on(packet, () => void moves.push(packet));
  harness.bot.attack(harness.bot.entities[ZOMBIE_ID]!);
  await harness.clock.advance(1_300);
  assert.deepEqual(velocities.slice(2, 5).map(({ z }) => z), [3, 6, 9].map((ticks) => Math.trunc(3200 * 0.98 ** ticks)));
  assert.deepEqual(velocities.slice(2, 5).map(({ atMs }, index) => atMs - velocities[1 + index]!.atMs), [150, 150, 150]);
  await harness.clock.advance(14_000);
  const last = velocities.at(-1)!;
  assert.deepEqual([last.x, last.y, last.z], [0, 0, 0], "the push ends with a velocity of zero");
  assert.ok(last.atMs > 11_000 && last.atMs < 14_000, `rested at ${last.atMs}`);
  const gaps = velocities.slice(1).map(({ atMs }, index) => atMs - velocities[index]!.atMs);
  assert.ok(gaps.every((gap) => gap % 150 === 0), `told at gaps of ${gaps}`);
  assert.ok(gaps.some((gap) => gap >= 300), "the tail is told sparsely: a change too small for 3 ticks waits for 6");
  const mob = harness.bot.entities[ZOMBIE_ID]!;
  assert.deepEqual([mob.position.x, mob.position.y, mob.position.z], [0.5, -60, 2.5]);
  assert.equal(mob.velocity.norm(), 0);
  assert.deepEqual(moves, []);
});

test("a second hit on a mob still moving halves its velocity and adds the new push; a hit that kills pushes nothing; a removed mob's push ends", async () => {
  const harness = fight({ slots: {} });
  const velocities = listenToVelocities(harness, ZOMBIE_ID);
  harness.bot.attack(harness.bot.entities[ZOMBIE_ID]!);
  await harness.clock.advance(600);
  harness.bot.attack(harness.bot.entities[ZOMBIE_ID]!);
  await harness.clock.advance(100);
  const second = velocities.at(-1)!.z / 8000;
  assert.ok(second > 0.5 && second < 0.6, `0.4 and half of the 0.31 left: ${second}`);

  const doomed = fight({ slots: {} });
  doomed.combat.hurt(ZOMBIE_ID, OTHER_ID, 19);
  await doomed.clock.advance(1_000);
  const doomedVelocities = listenToVelocities(doomed, ZOMBIE_ID);
  const dead: number[] = [];
  doomed.bot.on("entityDead", (entity) => void dead.push(entity.id));
  doomed.bot.attack(doomed.bot.entities[ZOMBIE_ID]!);
  await doomed.clock.advance(200);
  assert.deepEqual(dead, [ZOMBIE_ID], "the hit killed it");
  assert.deepEqual(doomedVelocities, [], "a mob killed by the hit is told no push");

  const gone = fight({ slots: {} });
  const goneVelocities = listenToVelocities(gone, ZOMBIE_ID);
  gone.bot.attack(gone.bot.entities[ZOMBIE_ID]!);
  await gone.clock.advance(100);
  gone.entities.remove(ZOMBIE_ID);
  const heardUntilRemoved = goneVelocities.length;
  await gone.clock.advance(2_000);
  assert.equal(goneVelocities.length, heardUntilRemoved, "no packet for a mob that left");
});

test("a knocked mob is still in reach: a stopped server tells nothing more, and the next hit lands once it runs again", async () => {
  const harness = fight({ slots: {} });
  const velocities = listenToVelocities(harness, ZOMBIE_ID);
  harness.bot.attack(harness.bot.entities[ZOMBIE_ID]!);
  await harness.clock.advance(1_000);
  harness.server.stop();
  const told = velocities.length;
  await harness.clock.advance(2_000);
  assert.equal(velocities.length, told, "a stopped server sends nothing");
  harness.server.resume();
  harness.bot.attack(harness.bot.entities[ZOMBIE_ID]!);
  await harness.clock.advance(200);
  assert.equal(healthOf(harness, ZOMBIE_ID), 18, "a second hit by hand: 20 - 1 - 1");
});

/** The packets the client hears for `id`, with the clock reading of each. */
function listenToBall(harness: FakeHarness, id: number) {
  const heard: { atMs: number; name: string; packet: Record<string, unknown> }[] = [];
  for (const name of ["entity_velocity", "rel_entity_move", "entity_move_look", "sync_entity_position"]) {
    harness.bot._client.on(name, (packet: Record<string, unknown>) => void (packet.entityId === id && heard.push({ atMs: harness.clock.now(), name, packet })));
  }
  return heard;
}

test("a launched fireball is told rarely: a move of zero at its 1st tick, then its velocity and a relative move at the 2nd, 10th and 20th", async () => {
  const harness = fight();
  const ball = harness.combat.launchFireball(new Vec3(8.5, -59.1, 0.5), new Vec3(-0.2, 0, 0));
  const heard = listenToBall(harness, ball.id);
  await harness.clock.advance(1_050);
  assert.deepEqual(heard.map(({ name }) => name), ["rel_entity_move", "entity_velocity", "entity_move_look", "entity_velocity", "entity_move_look", "entity_velocity", "entity_move_look"]);
  assert.deepEqual(heard.map(({ atMs }) => atMs - heard[0]!.atMs), [0, 50, 50, 450, 450, 950, 950]);
  assert.deepEqual([heard[0]!.packet.dX, heard[0]!.packet.dZ], [0, 0]);
  const velocities = heard.filter(({ name }) => name === "entity_velocity").map(({ packet }) => (packet.velocity as { x: number }).x);
  assert.deepEqual(velocities, [2, 10, 20].map((ticks) => Math.trunc((0.38 - 0.18 * 0.95 ** ticks) * -8000)));
  assert.ok(Math.abs(heard[2]!.packet.dX as number / 4_096 - -0.4266) < 0.001, "its first move is the two ticks' flight");
  assert.ok(ball.position.x < 8.5 - 2.9, `the client has it at ${ball.position.x}`);
});

test("a ball hit in reach flies along the look: the velocity and a move of zero at once, 1 block a tick and speeding up by 0.1", async () => {
  const harness = fight();
  harness.bot.entity.yaw = -Math.PI / 2;
  harness.bot.entity.pitch = 0;
  const ball = harness.combat.launchFireball(new Vec3(4.5, -59.1, 0.5), new Vec3(-0.2, 0, 0));
  const heard = listenToBall(harness, ball.id);
  harness.bot.attack(ball);
  await harness.clock.advance(100);
  const deflected = heard.find(({ name, packet }) => name === "entity_velocity" && (packet.velocity as { x: number }).x > 0)!;
  assert.deepEqual(deflected.packet.velocity, { x: 8_000, y: 0, z: 0 });
  assert.equal(heard[heard.indexOf(deflected) + 1]!.name, "rel_entity_move");
  await harness.clock.advance(1_000);
  const speeds = heard.filter(({ name, atMs }) => name === "entity_velocity" && atMs > deflected.atMs).map(({ packet }) => (packet.velocity as { x: number }).x);
  assert.ok(speeds.length >= 2 && speeds[0]! > 8_000 && speeds[1]! > speeds[0]!, `speeds ${speeds}`);
  assert.ok(ball.position.x > 10, `the client has the ball at ${ball.position.x}`);
});

test("a ball hit out of reach flies on at the bot, hurts her for 6 whatever the difficulty and blows up in that tick", async () => {
  const harness = fight();
  const order: string[] = [];
  const damage: { sourceTypeId: number; sourceCauseId: number; sourceDirectId: number }[] = [];
  harness.bot._client.on("damage_event", (packet: (typeof damage)[number]) => void (order.push("damage"), damage.push(packet)));
  harness.bot._client.on("explosion", () => void order.push("explosion"));
  harness.bot.on("entityGone", (entity) => void (entity.name === "fireball" && order.push("gone")));
  const ball = harness.combat.launchFireball(new Vec3(8.5, -59.1, 0.5), new Vec3(-0.2, 0, 0));
  harness.bot.attack(ball);
  await harness.clock.advance(2_000);
  assert.deepEqual(order, ["damage", "explosion", "gone"]);
  assert.equal(damage[0]!.sourceCauseId, ball.id + 1);
  assert.equal(damage[0]!.sourceDirectId, ball.id + 1);
  assert.equal(damage[0]!.sourceTypeId, damageTypeOf(harness, "unattributed_fireball"));
  assert.equal(harness.bot.health, 14, "6 whatever the difficulty; the blast inside her hurt window costs no more");
  assert.ok(harness.bot.entity.velocity.norm() > 0, "the blast pushes her");
});

test("a ball that is removed, a stopped server and a creative bot: no hurt after removal, nothing flies while stopped, a creative bot is not hurt but the ball still goes", async () => {
  const removed = fight();
  const ball = removed.combat.launchFireball(new Vec3(8.5, -59.1, 0.5), new Vec3(-0.2, 0, 0));
  await removed.clock.advance(300);
  removed.entities.remove(ball.id);
  await removed.clock.advance(3_000);
  assert.equal(removed.bot.health, 20);

  const stopped = fight();
  const frozen = stopped.combat.launchFireball(new Vec3(8.5, -59.1, 0.5), new Vec3(-0.2, 0, 0));
  stopped.server.stop();
  await stopped.clock.advance(3_000);
  assert.equal(stopped.bot.health, 20);
  assert.equal(frozen.position.x, 8.5, "the client was told nothing of a ball on a stopped server");
  stopped.server.resume();
  await stopped.clock.advance(2_000);
  assert.equal(stopped.bot.health, 14);

  const creative = fight({ gameMode: "creative" });
  const harmless = creative.combat.launchFireball(new Vec3(8.5, -59.1, 0.5), new Vec3(-0.2, 0, 0));
  await creative.clock.advance(2_000);
  assert.equal(creative.bot.health, 20);
  assert.equal(creative.bot.entities[harmless.id], undefined, "the ball is gone all the same");
});

test("a bot that deflected a ball goes on: her next hit on a mob lands; a hit on anything but a launched fireball is the mob rules' own", async () => {
  const harness = fight();
  harness.bot.entity.yaw = -Math.PI / 2;
  const ball = harness.combat.launchFireball(new Vec3(4.5, -59.1, 0.5), new Vec3(-0.2, 0, 0));
  harness.bot.attack(ball);
  await harness.clock.advance(1_500);
  harness.bot.attack(harness.bot.entities[ZOMBIE_ID]!);
  await harness.clock.advance(200);
  assert.equal(healthOf(harness, ZOMBIE_ID), 14, "the sword's hit");
  const decoy = harness.entities.spawn({ name: "small_fireball", position: new Vec3(2.5, -59.1, 0.5), velocity: new Vec3(-1, 0, 0) });
  harness.bot.attack(decoy);
  await harness.clock.advance(200);
  assert.equal(decoy.velocity.x, -1, "a small fireball is not hit");
});

test("a bot that died of a fireball and came back is not burning: the old fire does not follow her into her next life", async () => {
  const harness = shooters();
  harness.combat.setHealth(3);
  harness.combat.shootBot("small_fireball", BLAZE_ID, 3.5);
  await harness.clock.advance(FIREBALL_FLIGHT_MS);
  assert.equal(harness.bot.health, 0);
  harness.combat.setHealth(20);
  await harness.clock.advance(6_000);
  assert.equal(harness.bot.health, 20, "no burn after the respawn");
  assert.equal(Number(harness.bot.entity.metadata[0] ?? 0) & 1, 0);
});

test("a hit that does not open the mob's hurt window pushes it no more than it tells the client of it", async () => {
  const harness = fight({ slots: { 36: { name: "iron_sword" } } });
  harness.combat.hurt(ZOMBIE_ID, OTHER_ID, 0.5);
  const velocities = listenToVelocities(harness, ZOMBIE_ID);
  const hurts: number[] = [];
  harness.bot.on("entityHurt", (entity) => void hurts.push(entity.id));
  harness.bot.attack(harness.bot.entities[ZOMBIE_ID]!);
  await harness.clock.advance(100);
  assert.deepEqual(hurts, [], "the window is open: nothing is told of the hurt");
  assert.deepEqual(velocities, [], "and no push");
  assert.ok(healthOf(harness, ZOMBIE_ID) < 19.5, "the excess still counts");
});

test("a deflect is a swing: the next hit on a mob a moment later is a weak one", async () => {
  const harness = fight();
  harness.bot.entity.yaw = -Math.PI / 2;
  const ball = harness.combat.launchFireball(new Vec3(4.5, -59.1, 0.5), new Vec3(-0.2, 0, 0));
  harness.bot.attack(ball);
  await harness.clock.advance(100);
  harness.bot.attack(harness.bot.entities[ZOMBIE_ID]!);
  await harness.clock.advance(100);
  assert.ok(healthOf(harness, ZOMBIE_ID) > 17, `a sword swing 100 ms after the deflect cost ${20 - healthOf(harness, ZOMBIE_ID)}`);
});

test("a sprinting hit with a rested swing pushes along the look as well, and clears the sprint", async () => {
  const harness = fight({ slots: { 36: { name: "iron_sword" } } });
  harness.bot.entity.yaw = Math.PI;
  harness.bot.setControlState("sprint", true);
  const velocities = listenToVelocities(harness, ZOMBIE_ID);
  harness.bot.attack(harness.bot.entities[ZOMBIE_ID]!);
  await harness.clock.advance(100);
  assert.deepEqual([velocities[0]!.x, velocities[0]!.z], [0, 5600], "0.2 away and 0.5 along the look, both toward +z");
  const other = listenToVelocities(harness, OTHER_ID);
  await harness.clock.advance(1_500);
  harness.bot.attack(harness.bot.entities[OTHER_ID]!);
  await harness.clock.advance(100);
  assert.deepEqual([other[0]!.x, other[0]!.z], [-3_200, 0], "the key is still down but the server cleared the sprint: a plain 0.4 away");
});
