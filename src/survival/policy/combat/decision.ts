import type { ResponseExclusion } from "../../control/contract.js";
import type { Facts } from "../../state/answered.js";
import type { CombatPolicy } from "./contract.js";
import { needsCombatRecovery } from "./health.js";
import type { EvadeReason, HostileDirective, HostileThreat } from "./response.js";
import { compareTargets, type TargetFacts } from "./target-utility.js";
import type { ThreatAssessment } from "../../perception/combat/threat-assessment.js";
import { bareHand } from "../../../world/combat-data.js";

/** Intent authorizes a quarry; automatic engagement permission does not erase it. */
export type CombatPurpose =
  /** `quarry` names species an admitted hunt is deliberately pursuing; contact with them is fought, not fled. */
  | { readonly kind: "automatic"; readonly quarry?: readonly string[] }
  | { readonly kind: "pursuit"; readonly targetId: number; readonly minimumHealth: number }
  | { readonly kind: "contact_defence"; readonly targetId: number }
  | { readonly kind: "recovery"; readonly targetId: number | null }
  | { readonly kind: "handoff" };

export interface CombatContact extends HostileThreat {
  readonly relationship: {
    readonly avoid: boolean;
    readonly defend: boolean;
    readonly attention: "on_sight" | "observed_attack" | "inferred_head_gaze" | "unknown";
  };
  readonly inContact: boolean;
  readonly inReach: boolean;
  readonly defendsOnContact: boolean;
  readonly ranged: boolean;
  readonly utility: TargetFacts;
}

/** A single observation is consumed by a pure decision. No controls or world reads here. */
export interface CombatDecisionFacts {
  readonly policy: Readonly<CombatPolicy>;
  readonly health: number;
  readonly burning: boolean;
  readonly hideAllowed: boolean;
  readonly recoveryAvailable: boolean;
  readonly weapon: boolean;
  readonly assessment: ThreatAssessment;
  readonly rangedWeapon: boolean;
  readonly shield: boolean;
  readonly contacts: readonly CombatContact[];
  readonly fireball: HostileThreat | null;
  /** Target -> retained failed-fight entry for the current scope, independently of reachability. */
  readonly answeredFights: ReadonlyMap<number, number>;
  /** Quarry damage exhaustion remains answered even when contact is reachable. */
  readonly quarryAnsweredFights?: ReadonlySet<number>;
  readonly answered: ReadonlySet<string>;
}

/** Automatic defence can hold contact without authorizing a pursuit at low health. */
export function decideFightMovement(facts: {
  readonly policy: Readonly<CombatPolicy>;
  readonly health: number;
  readonly target: { readonly name: string; readonly defendsOnContact: boolean } | null;
}): "hold" | "pursue" {
  return facts.policy.engagement === "defend_only" ||
    needsCombatRecovery(facts.health, facts.policy.engage_min_health) ||
    (!facts.policy.melee && !facts.policy.bow) ||
    facts.target?.defendsOnContact ||
    facts.target?.name === "enderman"
    ? "hold"
    : "pursue";
}

/** The exact pure inputs and output, converted once at the receipt boundary. */
export function combatDecisionEvidence(
  facts: CombatDecisionFacts,
  purpose: CombatPurpose,
  decision: HostileDirective,
): Facts {
  return {
    purpose: { ...purpose },
    inputs: {
      ...facts,
      assessment: {
        ...facts.assessment,
        bot: { ...facts.assessment.bot }, weapon: { ...facts.assessment.weapon }, source: { ...facts.assessment.source },
        contacts: facts.assessment.contacts.map((contact) => ({ ...contact,
          explosion: contact.explosion ? { ...contact.explosion } : null })),
      },
      policy: { ...facts.policy, terrain: { ...facts.policy.terrain } },
      contacts: facts.contacts.map((contact) => ({
        ...contact,
        position: { ...contact.position },
        relationship: { ...contact.relationship },
        utility: { ...contact.utility },
      })),
      fireball: facts.fireball ? { ...facts.fireball, position: { ...facts.fireball.position } } : null,
      answeredFights: [...facts.answeredFights],
      quarryAnsweredFights: [...(facts.quarryAnsweredFights ?? [])],
      answered: [...facts.answered],
    },
    decision:
      "threats" in decision
        ? { ...decision, threats: decision.threats.map((threat) => ({ ...threat, position: { ...threat.position } })) }
        : { ...decision },
  };
}

/** Explain a refused automatic decision using its actual permissions and retained answers. */
export function combatResponseExclusions(
  facts: CombatDecisionFacts,
  reason: string,
  entries: ReadonlyMap<string, number>,
): readonly { response: string; excluded: ResponseExclusion }[] {
  const unavailable = { kind: "infeasible_now", premise: reason } as const;
  const answered = (response: string, fallback: ResponseExclusion): ResponseExclusion => {
    const entry = entries.get(response);
    return entry === undefined ? fallback : { kind: "answered", entry };
  };
  const policy = facts.policy;
  const hide: ResponseExclusion =
    policy.hide === "never"
      ? { kind: "prohibited", field: "hide" }
      : policy.hide === "when_recovery_possible" && policy.recover === "never"
        ? { kind: "prohibited", field: "recover" }
        : !facts.hideAllowed
          ? { kind: "missing_equipment", item: "food or an observed source of regeneration" }
          : answered("hide", answered("recovery", unavailable));
  const fight: ResponseExclusion =
    !policy.melee && !policy.bow ? { kind: "prohibited", field: "melee,bow" } : answered("fight", unavailable);
  const evade: ResponseExclusion = !policy.retreat
    ? { kind: "prohibited", field: "retreat" }
    : answered("evade", unavailable);
  return [
    { response: "fight", excluded: fight },
    { response: "hide", excluded: hide },
    { response: "evade", excluded: evade },
    ...(facts.fireball
      ? [
          {
            response: "deflect",
            excluded: !policy.melee
              ? { kind: "prohibited" as const, field: "melee" }
              : answered("deflect", unavailable),
          },
        ]
      : []),
  ];
}

/** Immediate defence remains available even when withdrawal is prohibited or spent. */
function defendContact(facts: CombatDecisionFacts, threats: readonly HostileThreat[]): HostileDirective {
  const { policy, contacts, answered } = facts;
  const target = contacts.find(
    (threat) =>
      !fightAnswered(facts, threat.id) &&
      threat.relationship.defend &&
      (threat.inReach || (policy.shield && facts.shield && threat.ranged && threat.inContact)),
  );
  return target && !answered.has("fight") && (policy.melee || (policy.shield && facts.shield))
    ? { kind: "fight", targetId: target.id, threats }
    : blocked(
        `No permitted response can progress. Retreat ${policy.retreat ? "answered" : "prohibited"}; no authorized immediate defence.`,
      );
}

/**
 * Defend-only contact defence of a target in reach. While withdrawal is open the target out of reach would be
 * `evade("withdraw")`, so a fight on a contact that is in reach ends when that contact leaves reach (`endsOnContactLoss`).
 * Defence the policy leaves no withdrawal for (retreat prohibited or the evade answered) and shield defence of a contact
 * out of reach end as they always did.
 */
function defendReachedContact(facts: CombatDecisionFacts, threats: readonly HostileThreat[]): HostileDirective {
  const defence = defendContact(facts, threats);
  if (defence.kind !== "fight" || !facts.policy.retreat || facts.answered.has("evade")) return defence;
  const defended = facts.contacts.find((contact) => contact.id === defence.targetId);
  return defended?.inReach ? { ...defence, endsOnContactLoss: true } : defence;
}

/** A retained fight failure excludes only its target, unless the whole response is answered. */
function fightAnswered(facts: CombatDecisionFacts, targetId: number): boolean {
  const inReach = facts.health >= facts.policy.engage_min_health &&
    facts.contacts.some(contact => contact.id === targetId && contact.inReach);
  return facts.answered.has("fight") || facts.quarryAnsweredFights?.has(targetId) === true ||
    (!inReach && facts.answeredFights.has(targetId));
}

/** Keep refusal wording shared by purpose and withdrawal branches. */
function blocked(why: string): HostileDirective {
  return { kind: "constrained", reason: `[COMBAT_CONSTRAINED] ${why}` };
}

/** A spent automatic withdrawal falls back to contact defence rather than repeating the evade. */
function withdraw(facts: CombatDecisionFacts, purpose: CombatPurpose, threats: readonly HostileThreat[], reason: EvadeReason): HostileDirective {
  return facts.policy.retreat && !facts.answered.has("evade")
    ? { kind: "evade", threats, safeRange: facts.policy.evade_safe_range, reason }
    : purpose.kind === "automatic"
      ? defendContact(facts, threats)
      : blocked("Withdrawal is prohibited or answered for this scope.");
}

export function decideCombatResponse(facts: CombatDecisionFacts, purpose: CombatPurpose): HostileDirective {
  const { policy, contacts, health, answered } = facts;
  const threats = contacts.map(({ id, name, position, distance }) => ({ id, name, position, distance }));
  const evade = (reason: EvadeReason) => withdraw(facts, purpose, threats, reason);
  const hideAvailable = facts.hideAllowed && !answered.has("hide");

  if (facts.fireball && policy.melee && !answered.has("deflect"))
    return { kind: "deflect", targetId: facts.fireball.id, reason: "incoming_fireball", threats: [facts.fireball] };
  if (purpose.kind === "contact_defence" && fightAnswered(facts, purpose.targetId)) return evade("unreachable");
  if (purpose.kind === "contact_defence")
    return policy.melee || policy.bow || (policy.shield && facts.shield)
      ? { kind: "fight", targetId: purpose.targetId, threats }
      : blocked("No permitted attack or shield capability remains for contact defence.");
  if (purpose.kind === "recovery") {
    if (answered.has("recovery")) return blocked("Protected recovery is exhausted under unchanged recovery premises.");
    if (policy.recover === "never" || !facts.recoveryAvailable)
      return blocked(
        "Recovery is prohibited or no carried food, sufficient hunger or regeneration effect can restore health.",
      );
    return hideAvailable ? { kind: "hide", threats, reason: "hurt" } : evade("withdraw");
  }
  if (purpose.kind === "handoff") {
    if (health < policy.engage_min_health && hideAvailable) return { kind: "hide", threats, reason: "hurt" };
    if (policy.retreat && !answered.has("evade")) return evade("withdraw");
    return hideAvailable
      ? { kind: "hide", threats, reason: "cornered" }
      : blocked("No permitted, unanswered handoff response remains.");
  }
  if (purpose.kind === "pursuit") {
    if (fightAnswered(facts, purpose.targetId)) return evade("unreachable");
    if (needsCombatRecovery(health, purpose.minimumHealth))
      return decideCombatResponse(facts, { kind: "recovery", targetId: purpose.targetId });
    return policy.melee || policy.bow
      ? { kind: "fight", targetId: purpose.targetId, threats }
      : blocked("The requested target remains authorized, but both attack capabilities are prohibited.");
  }

  return decideAutomaticCombat(facts, purpose, threats);
}

/** Rank attackable contacts with assessed explosives last, keeping quarry and utility preferences. */
function chooseAutomaticTarget(facts: CombatDecisionFacts, candidates: readonly CombatContact[], quarry: ReadonlySet<string>): CombatContact | undefined {
  const explosiveIds = new Set(facts.assessment.contacts.filter((contact) => contact.explosion !== null).map((contact) => contact.id));
  return candidates.filter((contact) => !fightAnswered(facts, contact.id)).sort((a, b) =>
    Number(explosiveIds.has(a.id)) - Number(explosiveIds.has(b.id)) ||
    Number(quarry.has(b.name)) - Number(quarry.has(a.name)) ||
    compareTargets(a.utility, b.utility) || a.id - b.id)[0];
}

/** Automatic engagement weighs melee advantage; explicit pursuit and contact defence bypass it. */
function decideAutomaticCombat(facts: CombatDecisionFacts, purpose: Extract<CombatPurpose, { kind: "automatic" }>, threats: readonly HostileThreat[]): HostileDirective {
  const { policy, contacts, health, answered, assessment } = facts;
  const evade = (reason: EvadeReason) => withdraw(facts, purpose, threats, reason);
  const hideAvailable = facts.hideAllowed && !answered.has("hide");
  const hurtBadly = health < policy.critical_health;
  if (!(hurtBadly ? threats.length > 0 : contacts.some((threat) => threat.inContact))) return { kind: "none" };
  if (hurtBadly)
    return hideAvailable && !answered.has("recovery") ? { kind: "hide", threats, reason: "hurt" } : evade("hurt");
  if (!policy.melee && !policy.bow) return evade("withdraw");
  // A hunted species is the request's objective. Health rules above still
  // withdraw from it; nothing below does, because the hunt owns giving up on
  // a quarry it cannot fight, and it does so by its own stop counts.
  const quarry = new Set(purpose.quarry ?? []);
  const hunted = (threat: CombatContact) => quarry.has(threat.name);
  const candidates = contacts.filter(
    (threat) =>
      threat.inContact &&
      (health < policy.engage_min_health || !threat.defendsOnContact || threat.inReach || hunted(threat)),
  );
  const target = chooseAutomaticTarget(facts, candidates, quarry);
  if (!target) return candidates.some((threat) => !hunted(threat)) ? evade("unreachable") : { kind: "none" };
  if (answered.has("evade") && hideAvailable && !answered.has("recovery") && !hunted(target))
    return { kind: "hide", threats, reason: "cornered" };
  if (!target.relationship.defend && !hunted(target)) return evade("observed_aggression");
  const explosives = assessment.contacts.filter((threat) => threat.explosion !== null);
  if (
    explosives.some((threat) => threat.inContact) &&
    (assessment.weapon.damage <= bareHand(assessment.source.version).attackDamage ||
      (explosives.length > 1 && (!policy.bow || !facts.rangedWeapon)))
  )
    return evade("explosive");
  if (
    !hunted(target) && (assessment.contacts.some((contact) => contact.inContact && contact.unknownMelee) ||
      (assessment.margin !== null && assessment.margin < policy.fight_margin &&
        !(policy.bow && facts.rangedWeapon && !contacts.some((contact) => contact.inReach))))
  )
    return evade("outmatched");
  const needsRangedRecovery =
    (facts.burning || !policy.shield || !facts.shield) && contacts.every((threat) => threat.ranged && !threat.inReach);
  if (health < policy.engage_min_health && hideAvailable && !answered.has("recovery") && needsRangedRecovery)
    return { kind: "hide", threats, reason: "hurt" };
  if (health < policy.engage_min_health) {
    if (
      hideAvailable &&
      !answered.has("recovery") &&
      contacts.some((threat) => threat.name === "enderman" && threat.inContact)
    )
      return { kind: "hide", threats, reason: "hurt" };
    return evade("hurt");
  }
  if (answered.has("fight")) return hunted(target) ? { kind: "none" } : evade("unreachable");
  return policy.engagement === "defend_only" && !hunted(target)
    ? target.inReach
      ? defendReachedContact(facts, threats)
      : evade("withdraw")
    : { kind: "fight", targetId: target.id, threats };
}
