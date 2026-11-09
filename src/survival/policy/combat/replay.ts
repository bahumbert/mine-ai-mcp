import { z } from "zod";
import { combatPolicySchema, DEFAULT_COMBAT_POLICY } from "./contract.js";
import { decideCombatResponse, type CombatDecisionFacts } from "./decision.js";
import { decideFightBoundary } from "./fight-boundary.js";
import { decideHostileReflex } from "./reflex-decision.js";
import { bareHand, combatDataSource, damageScaling, mobCombatData } from "../../../world/combat-data.js";
import { assessThreats, type ThreatAssessment } from "../../perception/combat/threat-assessment.js";
import type { CombatContact } from "./decision.js";
import { MELEE_RANGE } from "../../weapons/equipment.js";
import { DEFAULT_MINECRAFT_VERSION } from "../../../server/config.js";

const position = z.object({ x: z.number(), y: z.number(), z: z.number() });
const threat = z.object({ id: z.number(), name: z.string(), position, distance: z.number() });
const finite = z.number().finite();
const assessmentSchema = z.object({
  bot: z.object({ effectiveHealth: finite, armor: finite, toughness: finite }),
  weapon: z.object({ item: z.string().nullable(), damage: finite, intervalTicks: finite }),
  contacts: z.array(z.object({
    id: finite, species: z.string(), damagePerHit: finite.nullable(),
    damageSource: z.enum(["observed", "attribute", "none"]), unknownMelee: z.boolean(),
    hitIntervalTicks: finite, health: finite, hitsToKill: finite, ticksToKill: finite,
    hitsToKillBot: finite.nullable(), inContact: z.boolean(),
    explosion: z.object({ radius: finite, fuseTicks: finite, fuseRemainingTicks: finite.nullable(), damageAtReach: finite }).nullable(),
  })),
  ticksToDie: finite.nullable(), ticksToClear: finite, healthLostToClear: finite, margin: finite.nullable(),
  source: z.object({ version: z.string(), measured: z.boolean() }),
});
const inputs = z.object({
  policy: combatPolicySchema.extend({ fight_margin: combatPolicySchema.shape.fight_margin.default(DEFAULT_COMBAT_POLICY.fight_margin) }),
  assessment: assessmentSchema.optional(),
  health: z.number(),
  burning: z.boolean(),
  hideAllowed: z.boolean(),
  recoveryAvailable: z.boolean(),
  weapon: z.boolean(),
  rangedWeapon: z.boolean(),
  shield: z.boolean(),
  fireball: threat.nullable(),
  unreachable: z.array(z.number()).optional(),
  // Older incident captures predate target-specific exclusion inputs.
  answeredFights: z.array(z.tuple([z.number(), z.number()])).default([]),
  answered: z.array(z.string()),
  contacts: z.array(
    threat.extend({
      relationship: z.object({
        avoid: z.boolean(),
        defend: z.boolean(),
        attention: z.enum(["on_sight", "observed_attack", "inferred_head_gaze", "unknown"]),
      }),
      inContact: z.boolean(),
      inReach: z.boolean(),
      defendsOnContact: z.boolean(),
      ranged: z.boolean(),
      utility: z.object({
        inReach: z.boolean(),
        visible: z.boolean(),
        hasHitUs: z.boolean(),
        safeDropGround: z.boolean(),
        distance: z.number(),
      }),
    }),
  ),
});
const purpose = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("automatic"), quarry: z.array(z.string()).optional() }),
  z.object({ kind: z.literal("pursuit"), targetId: z.number(), minimumHealth: z.number() }),
  z.object({ kind: z.literal("contact_defence"), targetId: z.number() }),
  z.object({ kind: z.literal("recovery"), targetId: z.number().nullable() }),
  z.object({ kind: z.literal("handoff") }),
]);
const selection = z.object({ inputs, purpose });
const recordSchema = z.union([
  z.object({
    boundary: z.literal("fight"),
    selection,
    protection: z.object({
      returnable: z.boolean(),
      atProtection: z.boolean(),
      foodLow: z.boolean(),
      foodAvailable: z.boolean(),
    }),
  }),
  z.object({
    selection,
    settling: z.boolean(),
    combatOwnsBody: z.boolean(),
    entries: z.array(z.object({ response: z.string(), entry: z.number() })),
  }),
  selection,
]);

/** Old recordings know only a weapon boolean: preserve their explosive rule without inventing a fight margin. */
export function legacyAssessment(contacts: readonly CombatContact[], weapon: boolean, version: string): ThreatAssessment {
  const hand = bareHand(version);
  const assessment = assessThreats({
    bot: { health: 20, absorption: 0, armor: 0, toughness: 0 }, difficulty: "normal",
    mobAttackScaling: damageScaling("mob_attack", version), explosionScaling: damageScaling("explosion", version),
    weapon: { item: null, attack: { ...hand, attackDamage: hand.attackDamage + Number(weapon) } },
    bareHand: hand, meleeReach: MELEE_RANGE, source: combatDataSource(version),
    contacts: contacts.map((contact) => ({ id: contact.id, species: contact.name, distance: contact.distance,
      inContact: contact.inContact, data: mobCombatData(contact.name, version), health: null,
      heldItemAttack: null, observedHitDamage: null, observedIntervalTicks: null, fuseRemainingTicks: null })),
  });
  return { ...assessment, margin: null };
}

/** Replay a recorded decision input without a bot, world, policy store or clock. */
export function replayCombatDecision(recorded: unknown) {
  const record = recordSchema.parse(recorded);
  const selected = "selection" in record ? record.selection : record;
  const facts: CombatDecisionFacts = {
    ...selected.inputs,
    assessment: selected.inputs.assessment ?? legacyAssessment(selected.inputs.contacts, selected.inputs.weapon, DEFAULT_MINECRAFT_VERSION),
    answeredFights: new Map(selected.inputs.answeredFights),
    answered: new Set(selected.inputs.answered),
  };
  if ("boundary" in record) {
    if (selected.purpose.kind !== "pursuit" && selected.purpose.kind !== "contact_defence")
      throw new Error("A fight boundary requires a pursuit or contact-defence purpose.");
    return decideFightBoundary(facts, selected.purpose, record.protection);
  }
  const directive = decideCombatResponse(facts, selected.purpose);
  return "settling" in record
    ? decideHostileReflex({
        facts,
        directive,
        settling: record.settling,
        combatOwnsBody: record.combatOwnsBody,
        entries: record.entries,
      })
    : directive;
}
