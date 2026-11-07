import assert from "node:assert/strict";
import test from "node:test";
import type { ItemAttack, MobCombatData } from "../../../world/combat-data.js";
import {
  assessThreats,
  damageAfterArmor,
  explosionDamage,
  HURT_IMMUNITY_TICKS,
  MOB_MELEE_INTERVAL_TICKS,
  scaleForDifficulty,
  UNKNOWN_MOB_HEALTH,
  type AssessmentInput,
} from "./threat-assessment.js";

type ContactInput = AssessmentInput["contacts"][number];

const BARE_HAND: ItemAttack = { attackDamage: 1, attackSpeed: 4 };
const HAND = { item: null, attack: BARE_HAND } as const;
const ZOMBIE_DATA: MobCombatData = {
  maxHealth: 20, attackDamage: 3, armor: 2, armorToughness: 0, movementSpeed: 0.23, followRange: 35, explosion: null, rangedExplosionPower: null,
};
const CREEPER_DATA: MobCombatData = { ...ZOMBIE_DATA, attackDamage: 2, armor: 0, explosion: { radius: 3, fuseTicks: 30 } };

function contact(id: number, overrides: Partial<ContactInput> = {}): ContactInput {
  return {
    id, species: "zombie", distance: 2, inContact: true, data: ZOMBIE_DATA, health: null, heldItemAttack: null,
    observedHitDamage: null, observedIntervalTicks: null, fuseRemainingTicks: null, ...overrides,
  };
}

function input(overrides: Partial<AssessmentInput> = {}): AssessmentInput {
  return {
    bot: { health: 20, absorption: 0, armor: 0, toughness: 0 },
    difficulty: "normal",
    mobAttackScaling: "when_caused_by_living_non_player",
    explosionScaling: "always",
    weapon: HAND,
    bareHand: BARE_HAND,
    meleeReach: 3,
    contacts: [contact(1)],
    source: { version: "1.21.4", measured: true },
    ...overrides,
  };
}

function withWeapon(attackDamage: number, attackSpeed: number): AssessmentInput["weapon"] {
  return { item: "test_weapon", attack: { attackDamage, attackSpeed } };
}

test("bare hands against one zombie: 22 hits, margin about 0.61", () => {
  const a = assessThreats(input());
  assert.equal(a.contacts[0]!.hitsToKill, 22);
  assert.ok(Math.abs(a.margin! - 0.61) < 0.005, `margin ${a.margin}`);
  assert.equal(a.weapon.item, null);
  assert.equal(a.weapon.damage, 1);
  assert.equal(a.weapon.intervalTicks, HURT_IMMUNITY_TICKS);
});

test("stone sword (5, 1.6): 2.13 against one zombie, 0.71 against two (the summed rate sits at the hurt-window cap)", () => {
  const stoneSword = withWeapon(5, 1.6);
  assert.ok(Math.abs(assessThreats(input({ weapon: stoneSword })).margin! - 2.13) < 0.005);
  const two = assessThreats(input({ weapon: stoneSword, contacts: [contact(1), contact(2, { distance: 2.5 })] }));
  assert.ok(Math.abs(two.margin! - 0.71) < 0.005, `margin ${two.margin}`);
  assert.equal(two.ticksToClear, 125);
});

test("three zombies: the summed rate is capped at 3/10 per tick", () => {
  const a = assessThreats(input({ contacts: [contact(1), contact(2), contact(3)] }));
  assert.ok(Math.abs(a.ticksToDie! - 20 / 0.3) < 1e-9, `ticksToDie ${a.ticksToDie}`);
});

test("one-hit weapons by the shipped numbers: hoe 0.30, iron pickaxe 1.33, wooden sword 1.78, iron sword 2.67", () => {
  const cases: [string, number, number, number][] = [
    ["wooden hoe", 1, 1, 0.3], ["iron pickaxe", 4, 1.2, 1.33], ["wooden sword", 4, 1.6, 1.78], ["iron sword", 6, 1.6, 2.67],
  ];
  for (const [name, damage, speed, expected] of cases) {
    const margin = assessThreats(input({ weapon: withWeapon(damage, speed) })).margin!;
    assert.ok(Math.abs(margin - expected) < 0.005, `${name}: ${margin}`);
  }
});

test("warden (attack 30, health 500): hitsToKillBot 1, margin below 0.1", () => {
  const warden = contact(1, { species: "warden", data: { ...ZOMBIE_DATA, maxHealth: 500, attackDamage: 30, armor: 0 } });
  const a = assessThreats(input({ contacts: [warden] }));
  assert.equal(a.contacts[0]!.hitsToKillBot, 1);
  assert.ok(a.margin! < 0.1, `margin ${a.margin}`);
});

test("creeper (radius 3, fuse 30): damagePerHit null, out of the totals, damageAtReach 16.75 at reach 3", () => {
  const a = assessThreats(input({ contacts: [contact(1, { species: "creeper", data: CREEPER_DATA, fuseRemainingTicks: 12 })] }));
  const creeper = a.contacts[0]!;
  assert.equal(creeper.damagePerHit, null);
  assert.equal(creeper.damageSource, "none");
  assert.equal(creeper.hitsToKillBot, null);
  assert.deepEqual(creeper.explosion, { radius: 3, fuseTicks: 30, fuseRemainingTicks: 12, damageAtReach: 16.75 });
  assert.equal(a.margin, null);
  assert.equal(a.ticksToDie, null);
  assert.equal(a.healthLostToClear, 0);
  assert.equal(a.ticksToClear, 0);
});

test("the blast at reach is scaled by the explosion scaling and reduced by armour", () => {
  const creeper = [contact(1, { species: "creeper", data: CREEPER_DATA })];
  const hard = assessThreats(input({ difficulty: "hard", contacts: creeper })).contacts[0]!.explosion!.damageAtReach;
  assert.equal(hard, damageAfterArmor(1.5 * 16.75, 0, 0));
  const never = assessThreats(input({ difficulty: "hard", explosionScaling: "never", contacts: creeper })).contacts[0]!.explosion!.damageAtReach;
  assert.equal(never, 16.75);
  const armoured = assessThreats(input({ bot: { health: 20, absorption: 0, armor: 6, toughness: 0 }, contacts: creeper })).contacts[0]!.explosion!.damageAtReach;
  assert.equal(armoured, damageAfterArmor(16.75, 6, 0));
  assert.equal(explosionDamage(6, 3), 0, "none at twice the radius");
  assert.equal(explosionDamage(9, 3), 0, "none beyond it");
});

test("a skeleton without an observed hit uses its attribute; an observed 4 replaces it", () => {
  const skeleton = { species: "skeleton", data: { ...ZOMBIE_DATA, attackDamage: 2 } } as const;
  const attribute = assessThreats(input({ contacts: [contact(1, skeleton)] })).contacts[0]!;
  assert.equal(attribute.damagePerHit, 2);
  assert.equal(attribute.damageSource, "attribute");
  const observed = assessThreats(input({ contacts: [contact(1, { ...skeleton, observedHitDamage: 4 })] })).contacts[0]!;
  assert.equal(observed.damagePerHit, 4);
  assert.equal(observed.damageSource, "observed");
  // an observed hit already has armour and difficulty applied: it is not reduced again
  const armoured = input({ bot: { health: 20, absorption: 0, armor: 6, toughness: 0 }, difficulty: "hard", contacts: [contact(1, { observedHitDamage: 2.5 })] });
  assert.equal(assessThreats(armoured).contacts[0]!.damagePerHit, 2.5);
});

test("an item held by the mob adds its bonus over the bare hand to the attribute", () => {
  const held = contact(1, { heldItemAttack: { attackDamage: 7, attackSpeed: 1.6 } });
  assert.equal(assessThreats(input({ contacts: [held] })).contacts[0]!.damagePerHit, 3 + 6);
  const weaker = contact(1, { heldItemAttack: { attackDamage: 0.5, attackSpeed: 1 } });
  assert.equal(assessThreats(input({ contacts: [weaker] })).contacts[0]!.damagePerHit, 3);
});

test("an observed interval of 200 is capped at 20; an observed 12 is used", () => {
  const slow = assessThreats(input({ contacts: [contact(1, { observedIntervalTicks: 200 })] })).contacts[0]!;
  assert.equal(slow.hitIntervalTicks, MOB_MELEE_INTERVAL_TICKS);
  const fast = assessThreats(input({ contacts: [contact(1, { observedIntervalTicks: 12 })] })).contacts[0]!;
  assert.equal(fast.hitIntervalTicks, 12);
  const none = assessThreats(input()).contacts[0]!;
  assert.equal(none.hitIntervalTicks, MOB_MELEE_INTERVAL_TICKS);
  const zero = assessThreats(input({ contacts: [contact(1, { observedIntervalTicks: 0 })] }));
  assert.equal(zero.contacts[0]!.hitIntervalTicks, MOB_MELEE_INTERVAL_TICKS, "an interval of 0 is ignored");
  assert.ok(Number.isFinite(zero.margin!));
});

test("unknown species: data null, no observed hit: damagePerHit null, damageSource none, health 20, no throw", () => {
  const a = assessThreats(input({ contacts: [contact(1, { species: "modded_thing", data: null })] }));
  const unknown = a.contacts[0]!;
  assert.equal(unknown.damagePerHit, null);
  assert.equal(unknown.damageSource, "none");
  assert.equal(unknown.health, UNKNOWN_MOB_HEALTH);
  assert.equal(unknown.hitsToKillBot, null);
  assert.equal(a.margin, null);
  const observed = assessThreats(input({ contacts: [contact(1, { data: null, observedHitDamage: 5 })] })).contacts[0]!;
  assert.equal(observed.damagePerHit, 5, "an observed hit still assesses an unknown species");
  assert.equal(observed.hitsToKillBot, 4);
});

test("a contact's health is its metadata, else the measured maximum, else 20", () => {
  assert.equal(assessThreats(input({ contacts: [contact(1, { health: 6 })] })).contacts[0]!.health, 6);
  assert.equal(assessThreats(input({ contacts: [contact(1, { data: { ...ZOMBIE_DATA, maxHealth: 40 } })] })).contacts[0]!.health, 40);
  assert.equal(assessThreats(input({ contacts: [contact(1, { data: { ...ZOMBIE_DATA, maxHealth: null } })] })).contacts[0]!.health, UNKNOWN_MOB_HEALTH);
});

test("a health that is not a finite number falls back to the maximum, never NaN in the totals", () => {
  const a = assessThreats(input({ contacts: [contact(1, { health: Number.NaN })] }));
  assert.equal(a.contacts[0]!.health, 20);
  assert.ok(Number.isFinite(a.margin!) && Number.isFinite(a.ticksToClear));
});

test("an observed hit of 0 is no observation: the attribute decides", () => {
  const a = assessThreats(input({ contacts: [contact(1, { observedHitDamage: 0 })] }));
  assert.equal(a.contacts[0]!.damageSource, "attribute");
  assert.equal(a.contacts[0]!.damagePerHit, 3);
});

test("peaceful: damage 0, ticksToDie null, margin null", () => {
  const a = assessThreats(input({ difficulty: "peaceful" }));
  assert.equal(a.contacts[0]!.damagePerHit, 0);
  assert.equal(a.ticksToDie, null);
  assert.equal(a.margin, null);
});

test("scaling: easy min(d/2+1, d), normal d, hard 1.5 d; scaling never: unscaled", () => {
  assert.equal(scaleForDifficulty(3, "easy", "always"), 2.5);
  assert.equal(scaleForDifficulty(1, "easy", "always"), 1);
  assert.equal(scaleForDifficulty(3, "normal", "always"), 3);
  assert.equal(scaleForDifficulty(3, "hard", "when_caused_by_living_non_player"), 4.5);
  assert.equal(scaleForDifficulty(3, "hard", null), 4.5);
  assert.equal(scaleForDifficulty(3, "peaceful", "always"), 0);
  assert.equal(scaleForDifficulty(3, "hard", "never"), 3);
  assert.equal(scaleForDifficulty(3, "peaceful", "never"), 3);
});

test("iron chestplate (armour 6) against a zombie hit of 3: 2.46", () => {
  assert.ok(Math.abs(damageAfterArmor(3, 6, 0) - 2.46) < 1e-9);
  const a = assessThreats(input({ bot: { health: 20, absorption: 0, armor: 6, toughness: 0 } }));
  assert.ok(Math.abs(a.contacts[0]!.damagePerHit! - 2.46) < 1e-9);
});

test("absorption 4 counts in effectiveHealth", () => {
  const a = assessThreats(input({ bot: { health: 20, absorption: 4, armor: 0, toughness: 0 } }));
  assert.equal(a.bot.effectiveHealth, 24);
  assert.ok(Math.abs(a.margin! - 24 / 33) < 1e-9);
});

test("a contact not in contact is listed but not in the totals", () => {
  const a = assessThreats(input({ contacts: [contact(1, { inContact: false, distance: 9 })] }));
  assert.equal(a.contacts.length, 1);
  assert.equal(a.contacts[0]!.inContact, false);
  assert.equal(a.contacts[0]!.damagePerHit, 3);
  assert.equal(a.margin, null);
  assert.equal(a.ticksToDie, null);
  assert.equal(a.ticksToClear, 0);
  const none = assessThreats(input({ contacts: [] }));
  assert.deepEqual([none.margin, none.ticksToDie, none.ticksToClear, none.healthLostToClear], [null, null, 0, 0], "no contact at all");
  assert.deepEqual(none.source, { version: "1.21.4", measured: true });
});

test("the nearest contact is killed first, ties by id", () => {
  const strong = contact(1, { distance: 4, data: { ...ZOMBIE_DATA, attackDamage: 6 } });
  const near = contact(2, { distance: 1 });
  const stoneSword = withWeapon(5, 1.6);
  const a = assessThreats(input({ weapon: stoneSword, contacts: [strong, near] }));
  // near first: rate(both) = min(6/20 + 3/20, 6/10) = 0.45 for 62.5 ticks, then 0.3 for 62.5 ticks
  assert.ok(Math.abs(a.healthLostToClear - (0.45 * 62.5 + 0.3 * 62.5)) < 1e-9, `${a.healthLostToClear}`);
  const tie = assessThreats(input({ weapon: stoneSword, contacts: [contact(2, { data: { ...ZOMBIE_DATA, attackDamage: 6 } }), contact(1)] }));
  // id 1 first at equal distance: 0.45 then 0.3
  assert.ok(Math.abs(tie.healthLostToClear - (0.45 * 62.5 + 0.3 * 62.5)) < 1e-9, `${tie.healthLostToClear}`);
});

test("a weapon that deals nothing or swings at speed 0 never gives Infinity", () => {
  for (const weapon of [withWeapon(0, 1.6), withWeapon(4, 0)]) {
    const a = assessThreats(input({ weapon }));
    assert.ok(Number.isFinite(a.contacts[0]!.ticksToKill), JSON.stringify(weapon));
    assert.ok(Number.isFinite(a.weapon.intervalTicks), JSON.stringify(weapon));
    assert.equal(a.weapon.item, null, "the numbers are the bare hand's, so the label says bare hands");
    assert.equal(a.weapon.damage, BARE_HAND.attackDamage);
  }
});

test("JSON round trip keeps every field (no Infinity, no NaN)", () => {
  const scenes: AssessmentInput[] = [
    input(),
    input({ difficulty: "peaceful" }),
    input({ contacts: [contact(1, { species: "creeper", data: CREEPER_DATA }), contact(2, { data: null })] }),
    input({ contacts: [contact(1), contact(2, { inContact: false })], weapon: withWeapon(6, 1.6) }),
    input({ contacts: [] }),
  ];
  for (const scene of scenes) {
    const a = assessThreats(scene);
    assert.deepEqual(JSON.parse(JSON.stringify(a)), a);
  }
});
