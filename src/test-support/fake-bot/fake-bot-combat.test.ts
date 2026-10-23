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
  const harness = fight({ slots: { 36: { name: "iron_pickaxe" } } });
  harness.bot.attack(harness.bot.entities[ZOMBIE_ID]!);
  await assert.rejects(harness.clock.advance(100), /does not know the damage of iron_pickaxe/u);
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
