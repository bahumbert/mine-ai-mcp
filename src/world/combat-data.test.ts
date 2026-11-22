import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot } from "../test-support/fake-bot/index.js";
import type { CombatDataFile } from "./combat-data-file.js";
import { bareHand, combatDataSource, damageScaling, hasSelfExplosion, itemAttack, mobCombatData, nearestCombatData, variesFields } from "./combat-data.js";
import shipped from "./data/combat-data/1.21.4.json" with { type: "json" };

const FILE: CombatDataFile = shipped;
const VERSION = "1.21.4";

test("a species' numbers are the shipped file's, a missing armour reads 0", () => {
  const zombie = mobCombatData("zombie", VERSION)!;
  assert.equal(zombie.attackDamage, FILE.mobs.zombie!.attackDamage);
  assert.equal(zombie.maxHealth, FILE.mobs.zombie!.maxHealth);
  assert.equal(zombie.armor, FILE.mobs.zombie!.armor ?? 0);
  assert.equal(zombie.explosion, null);
});

test("a field that varies between individuals reads null and is told apart from an attribute the species lacks", () => {
  const varying = Object.entries(FILE.varies).find(([species, fields]) => fields.includes("attackDamage") && FILE.mobs[species]?.attackDamage === null);
  assert.ok(varying !== undefined, "the measured file holds a melee species whose attack varies (hoglin, slime)");
  const [species, fields] = varying;
  assert.equal(mobCombatData(species, VERSION)!.attackDamage, null);
  assert.ok(variesFields(species, VERSION).includes("attackDamage"));
  assert.deepEqual(variesFields(species, VERSION), fields);
  assert.deepEqual(variesFields("zombie", VERSION), [], "a zombie's numbers are fixed");
  assert.deepEqual(variesFields("no_such_mob", VERSION), []);
});

test("a species the data lacks is null, never a throw", () => {
  assert.equal(mobCombatData("no_such_mob", VERSION), null);
  assert.equal(hasSelfExplosion("no_such_mob", VERSION), false);
  assert.equal(hasSelfExplosion(undefined, VERSION), false);
});

test("hasSelfExplosion is true for every species the file gives an explosion and false for the others", () => {
  const withExplosion = Object.entries(FILE.mobs).filter(([, mob]) => mob.explosion !== null).map(([name]) => name);
  const without = Object.entries(FILE.mobs).filter(([, mob]) => mob.explosion === null).map(([name]) => name);
  assert.ok(withExplosion.length > 0, "the measured file holds at least one self-exploding species");
  assert.ok(without.length > 0);
  for (const name of withExplosion) assert.equal(hasSelfExplosion(name, VERSION), true, name);
  for (const name of without) assert.equal(hasSelfExplosion(name, VERSION), false, name);
});

test("a null or unlisted item attacks like the bare hand, a listed one with its own numbers", () => {
  assert.deepEqual(itemAttack(null, VERSION), bareHand(VERSION));
  assert.deepEqual(itemAttack("dirt", VERSION), bareHand(VERSION));
  const [name, attack] = Object.entries(FILE.items)[0]!;
  assert.deepEqual(itemAttack(name, VERSION), attack);
  assert.notDeepEqual(itemAttack(name, VERSION), bareHand(VERSION));
});

test("an older server reads the shipped file and is told it was not measured on its version", () => {
  assert.deepEqual(combatDataSource("1.20.1"), { version: VERSION, measured: false });
  assert.deepEqual(combatDataSource(VERSION), { version: VERSION, measured: true });
  assert.equal(mobCombatData("zombie", "1.20.1")!.attackDamage, FILE.mobs.zombie!.attackDamage);
});

test("version choice: exact, else the nearest older, else the oldest newer", () => {
  const file = (version: string): CombatDataFile => ({ ...FILE, version });
  const files = [file("1.20.1"), file("1.21.4"), file("1.21.1")];
  assert.equal(nearestCombatData("1.21.1", files).version, "1.21.1");
  assert.equal(nearestCombatData("1.21.3", files).version, "1.21.1");
  assert.equal(nearestCombatData("1.19.4", files).version, "1.20.1");
  assert.equal(nearestCombatData("1.21.11", files).version, "1.21.4");
});

test("damage scaling comes from the jar's damage types; an unknown type is null", () => {
  assert.equal(damageScaling("mob_attack", VERSION), "when_caused_by_living_non_player");
  assert.equal(damageScaling("explosion", VERSION), "always");
  assert.equal(damageScaling("no_such_type", VERSION), null);
});

// What T3a reads from the fake, each cited to the check that measured it on the 1.21.4 server (plan 2026-11-07-p4-06a-threat T1b step 2).
const ZOMBIE_ID = 7;
const fight = () => createFakeBot({ position: new Vec3(0.5, -60, 0.5), entities: { [ZOMBIE_ID]: { name: "zombie", position: new Vec3(0.5, -60, 2.5) } } });

test("the fake gives a mob's health in its metadata, as the server does (tests/minecraft/contract/checks/attack-hurts-and-kills.ts)", () => {
  const { bot } = fight();
  const key = bot.registry.entitiesByName.zombie!.metadataKeys!.indexOf("health");
  assert.ok(key >= 0);
  assert.equal(bot.entities[ZOMBIE_ID]!.metadata[key], FILE.mobs.zombie!.maxHealth);
});

test("the fake sends a damage_event naming the mob, then an update_health with the new health (tests/minecraft/contract/checks/damage-event-to-bot.ts)", () => {
  const harness = fight();
  const order: string[] = [];
  harness.bot._client.on("damage_event", (packet: { entityId: number; sourceCauseId: number }) => void order.push(`damage_event ${packet.entityId === harness.bot.entity.id ? "bot" : "other"} cause ${packet.sourceCauseId}`));
  harness.bot._client.on("update_health", (packet: { health: number }) => void order.push(`update_health ${packet.health}`));
  harness.combat.hurtBot(3, ZOMBIE_ID);
  assert.deepEqual(order, [`damage_event bot cause ${ZOMBIE_ID + 1}`, "update_health 17"]);
});
