import type { Bot } from "mineflayer";
import { bareHand, combatDataSource, damageScaling, itemAttack, mobCombatData, variesFields } from "../../../world/combat-data.js";
import { botDefence, meleeWeapon, serverDifficulty } from "../../../world/combat-stats.js";
import { entityMetadata } from "../../../world/end-fight.js";
import { assessThreats, type AssessmentInput, type ThreatAssessment } from "../../perception/combat/threat-assessment.js";
import { isBurning, isInLava, isInWater } from "../../perception/body.js";
import { bowDrawAimedAtBot } from "../../perception/combat/attention.js";
import { defendsOnContact, inDefensiveContact } from "../../perception/combat/contact.js";
import { incomingFireball } from "../../perception/combat/fireball.js";
import { isRangedAttacker } from "../../perception/combat/observations.js";
import { recoveryAvailable } from "../../perception/combat/recovery.js";
import { targetFacts } from "../../perception/combat/target.js";
import {
  HOSTILE_CONTACT_RANGE,
  HOSTILE_OBSERVATION_RANGE,
  hostileRelationship,
  observeExposedAvoidanceContact,
} from "../../perception/combat/threats.js";
import { DEFAULT_COMBAT_POLICY, type CombatPolicy } from "../../policy/combat/contract.js";
import { DEFAULT_FOOD_POLICY } from "../../policy/contract.js";
import { decideCombatResponse, type CombatContact, type CombatDecisionFacts } from "../../policy/combat/decision.js";
import { permitsHide } from "../../policy/combat/permissions.js";
import type { HostileDirective, HostileThreat } from "../../policy/combat/response.js";
import { carriesCombatWeapon, carriesRangedWeapon, isShield, MELEE_RANGE, readCombatItems } from "../../weapons/equipment.js";
import { contextPolicy, type HostileContext } from "./context.js";
import { responseScope } from "./scopes/response.js";
const NO_CONTEXT: HostileContext = { resolvedIds: new Set(), attackerIds: new Set() };
function inContact(threat: HostileThreat, context: HostileContext): boolean {
  return threat.distance <= HOSTILE_CONTACT_RANGE || context.attackerIds.has(threat.id);
}

/** Combine one contact's live body, carried item and this connection's own observations. */
function assessmentContact(bot: Bot, contact: Pick<CombatContact, "id" | "name" | "distance" | "inContact">, context: HostileContext,
  fuses: ReadonlyMap<number, number | undefined>): AssessmentInput["contacts"][number] {
  const entity = bot.entities[contact.id];
  const health = entity ? entityMetadata(bot, entity, "health") : undefined;
  const hits = context.perception?.observedHits(contact.id);
  return {
    id: contact.id, species: contact.name, distance: contact.distance, inContact: contact.inContact,
    data: mobCombatData(contact.name, bot.version),
    health: typeof health === "number" && Number.isFinite(health) ? health : null,
    heldItemAttack: entity?.heldItem ? itemAttack(entity.heldItem.name, bot.version) : null,
    observedHitDamage: hits?.damage ?? null,
    observedIntervalTicks: hits?.intervalTicks ?? null,
    unknownMelee: variesFields(contact.name, bot.version).includes("attackDamage"),
    fuseRemainingTicks: fuses.get(contact.id) ?? null,
  };
}

/** Build the pure assessment from a single live reading of defence, equipment and contact facts. */
export function assessContacts(bot: Bot, contacts: readonly Pick<CombatContact, "id" | "name" | "distance" | "inContact">[], context: HostileContext): ThreatAssessment {
  const fuses = new Map(context.perception?.creeperClearance.observe(context.perception.tick, context.resolvedIds)
    .map((fuse) => [fuse.id, fuse.fuseRemainingTicks]));
  return assessThreats({
    bot: botDefence(bot), difficulty: serverDifficulty(bot),
    mobAttackScaling: damageScaling("mob_attack", bot.version), explosionScaling: damageScaling("explosion", bot.version),
    weapon: meleeWeapon(bot), bareHand: bareHand(bot.version), meleeReach: MELEE_RANGE,
    contacts: contacts.map((contact) => assessmentContact(bot, contact, context, fuses)),
    source: combatDataSource(bot.version),
  });
}

/** Reopen disproved approach failures before selection and admission read the same target memory. */
function observeAnsweredFights(bot: Bot, context: HostileContext, contacts: readonly CombatContact[]): Map<number, number> {
  const policy = context.policy ?? DEFAULT_COMBAT_POLICY;
  const answeredFights = new Map<number, number>();
  if (!context.survival) return answeredFights;
  for (const contact of contacts) {
    const scope = responseScope(bot, contextPolicy(context), "fight", contact.id);
    const entry = context.survival.answered.find(scope.capability, scope.scope);
    // A reachable attacker disproves an approach failure; clear admission's veto too.
    // Limit stand-downs remain time-only (P4-06c T2, 2026-11-09).
    if (entry && entry.failure.kind !== "reflex_limit" && bot.health >= policy.engage_min_health && contact.inReach) {
      context.survival.answered.forget(scope.capability, scope.scope);
      continue;
    }
    if (entry) answeredFights.set(contact.id, entry.id);
  }
  return answeredFights;
}

/** Read shared relationship, exposure and equipment once before deciding. */
export function observeCombatDecision(bot: Bot, context: HostileContext = NO_CONTEXT): CombatDecisionFacts {
  const policy = context.policy ?? DEFAULT_COMBAT_POLICY;
  const canRecover = recoveryAvailable(bot, context.food ?? DEFAULT_FOOD_POLICY);
  const fireball = incomingFireball(bot, HOSTILE_OBSERVATION_RANGE);
  const answered = new Set(context.blockedResponses);
  if (fireball && context.survival) {
    const scope = responseScope(bot, contextPolicy(context), "deflect", fireball.id);
    if (context.survival.answered.find(scope.capability, scope.scope)) answered.add("deflect");
  }
  const contacts: CombatContact[] = observeExposedAvoidanceContact(bot, context)
    .filter((threat) => threat.name !== "ender_dragon")
    .map((threat) => {
      const entity = bot.entities[threat.id]!;
      return {
        ...threat,
        relationship: hostileRelationship(bot, entity, context),
        // Exposed bow draws aimed at us are contact before their first projectile hits.
        inContact: inContact(threat, context) || bowDrawAimedAtBot(bot, entity),
        inReach: inDefensiveContact(bot, entity),
        defendsOnContact: defendsOnContact(bot, entity),
        ranged: isRangedAttacker(bot, entity),
        utility: targetFacts(bot, entity, context.attackerIds.has(entity.id)),
      };
    });
  return {
    policy,
    health: bot.health,
    burning: isBurning(bot),
    // A shelter needs ground: in a liquid the decision picks fight or evade (CMB-01).
    hideAllowed: permitsHide(policy, canRecover) && !isInWater(bot) && !isInLava(bot),
    recoveryAvailable: canRecover,
    weapon: carriesCombatWeapon(bot),
    rangedWeapon: carriesRangedWeapon(bot),
    shield: readCombatItems(bot).some((item) => isShield(bot, item)),
    assessment: assessContacts(bot, contacts, context),
    fireball: fireball
      ? {
          id: fireball.id,
          name: "fireball",
          position: { x: fireball.position.x, y: fireball.position.y, z: fireball.position.z },
          distance: fireball.position.distanceTo(bot.entity.position),
        }
      : null,
    contacts,
    answeredFights: observeAnsweredFights(bot, context, contacts),
    answered,
  };
}

export function observeHostileResponse(
  bot: Bot,
  context: HostileContext = NO_CONTEXT,
  policy: Readonly<CombatPolicy> = context.policy ?? DEFAULT_COMBAT_POLICY,
): HostileDirective {
  return decideCombatResponse(observeCombatDecision(bot, { ...context, policy }), { kind: "automatic" });
}
