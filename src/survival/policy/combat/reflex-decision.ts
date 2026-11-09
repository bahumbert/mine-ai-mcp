import type { ResponseDecision } from "../../control/contract.js";
import { combatResponseExclusions, type CombatDecisionFacts } from "./decision.js";
import type { EvadeReason, HideReason, HostileDirective, HostileResponse } from "./response.js";
import { bareHand } from "../../../world/combat-data.js";

export interface HostileDecisionFacts {
  readonly facts: CombatDecisionFacts;
  readonly directive: HostileDirective;
  readonly settling: boolean;
  readonly combatOwnsBody: boolean;
  readonly entries: readonly { readonly response: string; readonly entry: number }[];
}

/** Admission gates use the same captured observation as response selection and its receipt. */
export function decideHostileReflex(observed: HostileDecisionFacts): ResponseDecision<HostileResponse> {
  const { facts, directive } = observed;
  if (observed.settling) return { kind: "handled", by: "policy_settlement" };
  if (observed.combatOwnsBody) return { kind: "handled", by: "combat" };
  if (directive.kind === "none") return { kind: "handled", by: "no_contact" };
  if (directive.kind === "constrained")
    return {
      kind: "stand_down",
      candidates: combatResponseExclusions(
        facts,
        directive.reason,
        new Map(observed.entries.map(({ response, entry }) => [response, entry])),
      ),
    };
  // Where the threat stood is what lets a caller judge the withdrawal: the same
  // skeleton five blocks away and forty blocks away are different decisions.
  const names = directive.threats
    .map(
      (threat) =>
        `${threat.name}#${threat.id} at ${Math.floor(threat.position.x)},${Math.floor(threat.position.y)},${Math.floor(threat.position.z)}` +
        ` (${Math.round(threat.distance * 10) / 10} blocks)`,
    )
    .join(", ");
  const why = "reason" in directive ? ` (${describeDirectiveReason(directive.reason, facts)})` : "";
  return {
    kind: "respond",
    response: directive,
    // The `reason` text below is read by the brain's parser (brain/src/gathering/hostile-interruptions.ts): keep its format.
    name: directive.kind,
    identity: { kind: directive.kind, target: "targetId" in directive ? directive.targetId : directive.threats.map((threat) => threat.id).sort((a, b) => a - b),
      reason: "reason" in directive ? directive.reason : null },
    reason: `[HOSTILE_CONTACT] ${directive.kind} response for ${names}${why}.`,
  };
}

/**
 * The decision's own reason, spelled out for the caller whose request it
 * interrupts. Every action returns the interruption verbatim, so this is the
 * one place that decides whether a model can tell a withdrawal it should
 * accept from one it should fix with a policy edit or a different request.
 */
export function describeDirectiveReason(reason: EvadeReason | HideReason | "incoming_fireball", facts?: CombatDecisionFacts): string {
  switch (reason) {
    case "hurt":
      return "hurt: health is below the engagement minimum";
    case "explosive":
      return describeExplosive(facts);
    case "outmatched":
      return describeOutmatched(facts);
    case "unreachable":
      return "unreachable: no fight answer remains for this contact";
    case "observed_aggression":
      return "observed_aggression: aggression without attack authorization";
    case "withdraw":
      return "withdraw: no permitted attack, or defend_only engagement out of reach";
    case "cornered":
      return "cornered: withdrawal already answered";
    case "incoming_fireball":
      return "incoming fireball";
  }
}

/** Explain the priced melee loss without letting rounded numbers become the decision's identity. */
function describeOutmatched(facts?: CombatDecisionFacts): string {
  if (!facts) return "outmatched: the melee margin is below fight_margin; improve equipment or lower fight_margin";
  const { assessment, policy } = facts;
  const unknown = assessment.contacts.filter((contact) => contact.inContact && contact.unknownMelee);
  if (unknown.length)
    return `outmatched: unknown melee damage from ${unknown.map((contact) => contact.species).join(", ")}; keep away or choose explicit pursuit/contact defence`;
  const counts = new Map<string, number>();
  for (const contact of assessment.contacts.filter((contact) => contact.inContact && contact.damagePerHit !== null && contact.damagePerHit > 0))
    counts.set(contact.species, (counts.get(contact.species) ?? 0) + 1);
  const targets = [...counts].map(([species, count]) => `${count} ${species}`).join(", ");
  const weapon = assessment.weapon.item ?? "bare hands";
  return `outmatched: killing ${targets} with ${weapon} would cost ~${Math.round(assessment.healthLostToClear)} of your ${Math.round(assessment.bot.effectiveHealth)} health; ` +
    `margin ${assessment.margin?.toFixed(1) ?? "unknown"} under fight_margin ${policy.fight_margin.toFixed(1)}`;
}

/** Describe the blast estimate and the actual equipment premise that made withdrawal necessary. */
function describeExplosive(facts?: CombatDecisionFacts): string {
  if (!facts) return "explosive: explosive contact without a safe weapon answer; improve equipment or keep away";
  const { assessment } = facts;
  const contact = assessment.contacts.find((contact) => contact.inContact && contact.explosion !== null);
  const threat = facts.contacts.find((threat) => threat.id === contact?.id);
  if (!contact?.explosion || !threat) return "explosive: explosive contact without a safe weapon answer; keep away";
  const premise = assessment.weapon.damage <= bareHand(assessment.source.version).attackDamage
    ? "you carry nothing stronger than a bare hand"
    : "multiple explosives and no permitted ranged weapon answer; keep away";
  return `explosive: ${contact.species} at ${Math.round(threat.distance)} blocks can deal ~${Math.round(contact.explosion.damageAtReach)} of your ${Math.round(assessment.bot.effectiveHealth)} health at melee reach; ${premise}`;
}
