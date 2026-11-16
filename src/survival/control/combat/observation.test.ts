import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot } from "../../../test-support/fake-bot/index.js";
import { assessContacts, observeCombatDecision } from "./observation.js";
import { CombatPerception } from "../../perception/combat/observations.js";
import { survivalResources } from "../../state/resources.js";
import { DEFAULT_SURVIVAL_POLICY } from "../../policy/contract.js";
import { responseScope } from "./scopes/response.js";
import { combatDecisionEvidence, decideCombatResponse } from "../../policy/combat/decision.js";
import { replayCombatDecision } from "../../policy/combat/replay.js";
import { DEFAULT_COMBAT_POLICY } from "../../policy/combat/contract.js";
import { describeDirectiveReason } from "../../policy/combat/reflex-decision.js";

test("unobserved hoglin melee blocks automatic fighting alone or beside a priced zombie", () => {
  for (const withZombie of [false, true]) {
    const { bot, combat, entities } = createFakeBot({ entities: {
      3: { name: "hoglin", position: new Vec3(2.5, 64, 0.5) },
    } });
    if (withZombie) entities.spawn({ id: 2, name: "zombie", position: new Vec3(2.5, 64, -0.5) });
    using perception = new CombatPerception(bot);
    const context = { perception, resolvedIds: perception.resolvedIds, attackerIds: perception.attackerIds,
      policy: { ...DEFAULT_COMBAT_POLICY, fight_margin: 0.1 } };
    const facts = observeCombatDecision(bot, context);
    assert.equal(facts.assessment.weapon.item, null);
    assert.equal(facts.assessment.contacts.find((c) => c.id === 3)!.damageSource, "unknown");
    assert.equal(facts.assessment.margin, null, "a known neighbour cannot make the combined cost known");
    const response = decideCombatResponse(facts, { kind: "automatic" });
    assert.equal(response.kind === "evade" ? response.reason : response.kind, "outmatched");
    assert.deepEqual(replayCombatDecision(combatDecisionEvidence(facts, { kind: "automatic" }, response)), response);
    assert.match(describeDirectiveReason("outmatched", facts), /unknown.*hoglin.*keep away/i);
    assert.equal(decideCombatResponse(facts, { kind: "contact_defence", targetId: 3 }).kind, "fight");
    combat.hurtBot(2, 3);
    const measured = observeCombatDecision(bot, context);
    assert.equal(measured.assessment.contacts.find((c) => c.id === 3)!.unknownMelee, false);
    assert.equal(decideCombatResponse(measured, { kind: "automatic" }).kind, "fight");
  }
});

test("an answered fight for a contact is still found", () => {
  const { bot } = createFakeBot({ entities: { 2: { name: "zombie", position: new Vec3(4.5, 64, 0.5) } } });
  const survival = survivalResources();
  const entry = survival.answered.remember(responseScope(bot, () => DEFAULT_SURVIVAL_POLICY, "fight", 2),
    { kind: "unreachable", why: "No route reached this target." },
    { premise: "unreachable", ticks: 600, why: "The previous approach failed." });
  const facts = observeCombatDecision(bot, { survival, resolvedIds: new Set(), attackerIds: new Set() });
  assert.ok(facts.contacts.some(contact => contact.id === 2));
  assert.equal(facts.answeredFights.get(2), entry.id);
});

/** A bot alone on dry ground, hurt enough that hiding is the policy's answer to a threat. */
function loneBot(body: { readonly isInWater?: boolean; readonly isInLava?: boolean } = {}): Bot {
  const { bot } = createFakeBot({ health: 6, position: new Vec3(0, 0, 0), server: { timeOfDay: 18_000 } });
  Object.assign(bot.entity, body);
  return bot;
}

test("hiding requires dry ground rather than water or lava", () => {
  for (const [body, allowed] of [[{}, true], [{ isInWater: true }, false], [{ isInLava: true }, false]] as const)
    assert.equal(observeCombatDecision(loneBot(body)).hideAllowed, allowed, JSON.stringify(body));
});

test("contact assessment weighs a nearby zombie with bare hands and finite live health", () => {
  const { bot } = createFakeBot({ entities: { 2: { name: "zombie", position: new Vec3(2.5, 64, 0.5) } } });
  const context = { resolvedIds: new Set<number>(), attackerIds: new Set<number>() };
  const observed = observeCombatDecision(bot, context);
  const contacts = observed.contacts;
  const assessment = assessContacts(bot, contacts, context);
  assert.deepEqual(observed.assessment, assessment);
  assert.ok(Math.abs(assessment.margin! - 0.60606) < 0.001);
  assert.equal(assessment.contacts[0]!.damagePerHit, 3);
  const health = bot.registry.entitiesByName.zombie!.metadataKeys!.indexOf("health");
  for (const value of [10, NaN, Infinity, undefined]) {
    Reflect.set(bot.entities[2]!.metadata, health, value);
    assert.equal(assessContacts(bot, contacts, context).contacts[0]!.health, value === 10 ? 10 : 20);
  }
});

test("assessment reads held bonuses, observations, explosion fuses and varying melee damage", () => {
  const { bot, combat } = createFakeBot({ entities: {
    2: { name: "zombie", position: new Vec3(2.5, 64, 0.5) },
    3: { name: "creeper", position: new Vec3(2.5, 64, 1.5) },
    4: { name: "slime", position: new Vec3(2.5, 64, -0.5) },
  }, carried: { stone_sword: 1 } });
  using perception = new CombatPerception(bot);
  const context = { perception, resolvedIds: perception.resolvedIds, attackerIds: perception.attackerIds };
  const contacts = observeCombatDecision(bot, context).contacts;
  bot.entities[2]!.equipment[0] = bot.inventory.items()[0]!;
  let assessed = assessContacts(bot, contacts, context);
  assert.equal(assessed.contacts.find((c) => c.id === 2)!.damagePerHit, 7);
  assert.equal(assessed.contacts.find((c) => c.id === 3)!.explosion!.fuseRemainingTicks, 30);
  assert.equal(assessed.contacts.find((c) => c.id === 4)!.unknownMelee, true);
  combat.hurtBot(4, 4);
  assessed = assessContacts(bot, contacts, context);
  assert.equal(assessed.contacts.find((c) => c.id === 4)!.damagePerHit, 4);
  assert.equal(assessed.contacts.find((c) => c.id === 4)!.unknownMelee, false);
  assert.equal(assessContacts(bot, contacts, { ...context, perception: undefined }).contacts.find((c) => c.id === 3)!.explosion!.fuseRemainingTicks, null);
});
