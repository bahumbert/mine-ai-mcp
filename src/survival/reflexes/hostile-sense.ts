// What the hostile reflex senses each tick: the contacts, the combat decision, and the answered responses.
import { observeCombatDecision } from "../control/combat/observation.js";
import { responseScope } from "../control/combat/scopes/response.js";
import { recoveryScope } from "../control/combat/scopes/recovery.js";
import type { AnsweredScope, Facts } from "../state/answered.js";
import { incomingFireball } from "../perception/combat/fireball.js";
import { HOSTILE_OBSERVATION_RANGE, isHostile, observeHostileContact } from "../perception/combat/threats.js";
import { combatDecisionEvidence, decideCombatResponse } from "../policy/combat/decision.js";
import { recoveryHealth } from "../policy/combat/health.js";
import type { HostileResponse } from "../policy/combat/response.js";
import type { ResponseDecision } from "../control/contract.js";
import { decideHostileReflex } from "../policy/combat/reflex-decision.js";
import { carriedShields, shieldInOffHand, type HostileScene } from "./hostile-scene.js";

export type ShieldPreparation = { readonly kind: "prepare_shield" };

/** The entry the driver holds for this response (and target), when it was answered and not reopened. */
function answeredEntry(scene: HostileScene, kind: HostileResponse["kind"], targetId?: number) {
  const scope = responseScope(scene.bot, () => scene.policy.effective, kind, targetId);
  return scene.driver.answered.find(scope.capability, scope.scope);
}

/** Track who threatens the bot in this encounter, and begin or end the policy's encounter with it. */
function observeEncounter(scene: HostileScene): void {
  const { bot, policy, context, encounterThreats, perception } = scene;
  const contacts = observeHostileContact(bot, context);
  for (const contact of contacts) encounterThreats.add(contact.id);
  for (const id of encounterThreats) {
    const entity = bot.entities[id];
    if (
      !entity?.isValid ||
      perception.resolvedIds.has(id) ||
      entity.position.distanceTo(bot.entity.position) >= policy.combat.evade_safe_range
    )
      encounterThreats.delete(id);
  }
  if (encounterThreats.size) policy.beginEncounter();
  else if (policy.snapshot().encounter) {
    policy.constrain(null);
    scene.transition(policy.endEncounter());
  }
}

/** The responses already answered for what the bot faces now: they decide against it, one entry per response. */
function answeredEntries(scene: HostileScene, facts: ReturnType<typeof observeCombatDecision>) {
  const { bot, policy, driver } = scene;
  const entries = new Map<string, number>();
  for (const kind of ["hide", "evade"] as const) {
    const entry = answeredEntry(scene, kind);
    if (entry) entries.set(kind, entry.id);
  }
  for (const contact of facts.contacts) {
    const entry = answeredEntry(scene, "fight", contact.id);
    if (entry) entries.set("fight", entry.id);
  }
  const recovery = recoveryScope(bot, () => policy.effective, recoveryHealth(policy.combat));
  const exhaustedRecovery = driver.answered.find(recovery.capability, recovery.scope);
  if (exhaustedRecovery) entries.set("recovery", exhaustedRecovery.id);
  if (facts.fireball) {
    const entry = answeredEntry(scene, "deflect", facts.fireball.id);
    if (entry) entries.set("deflect", entry.id);
  }
  return [...entries].map(([response, entry]) => ({ response, entry }));
}

/** Whether an available shield should be put in the off-hand before a hostile gets close. */
function shieldWanted(scene: HostileScene): boolean {
  const { bot, policy } = scene;
  return (
    policy.combat.shield &&
    !shieldInOffHand(bot) &&
    !bot.usingHeldItem &&
    !bot.currentWindow &&
    carriedShields(bot).length > 0 &&
    Object.values(bot.entities).some(
      (entity) => isHostile(entity) && entity.position.distanceTo(bot.entity.position) < HOSTILE_OBSERVATION_RANGE,
    )
  );
}

export function senseHostile(scene: HostileScene) {
  const { bot, policy, controller, perception } = scene;
  scene.transition(policy.refresh());
  observeEncounter(scene);
  // Aggression without attribution can require avoidance; it is not an attack authorization.
  const facts = observeCombatDecision(bot, scene.context);
  const purpose = { kind: "automatic", quarry: policy.quarry } as const;
  const directive = decideCombatResponse(facts, purpose);
  const prepareShield = shieldWanted(scene);
  if (!prepareShield && !facts.contacts.length && directive.kind === "none" && !incomingFireball(bot, 16)) return null;
  const entries = answeredEntries(scene, facts);
  const settling = policy.settling;
  const combatOwnsBody = controller.activeEngagement()?.kind === "mob";
  if (!settling && !combatOwnsBody) policy.constrain(directive.kind === "constrained" ? directive.reason : null);
  return {
    kind: "observed" as const,
    danger: { directive, purpose, prepareShield, facts, settling, combatOwnsBody, entries },
    evidence: {
      threats: facts.contacts.map((contact) => ({
        id: contact.id,
        name: contact.name,
        cell: bot.entities[contact.id]?.position.floored().toString() ?? null,
        relationship: { ...contact.relationship },
        confirmedAttacker: perception.attackerIds.has(contact.id),
      })),
      fireball: facts.fireball ? { ...facts.fireball, position: { ...facts.fireball.position } } : null,
    },
  };
}

type HostileDanger = NonNullable<ReturnType<typeof senseHostile>>["danger"];

export function hostileDecisionFacts({
  facts,
  directive,
  purpose,
  prepareShield,
  settling,
  combatOwnsBody,
  entries,
}: HostileDanger): Facts {
  return {
    selection: combatDecisionEvidence(facts, purpose, directive),
    prepareShield,
    settling,
    combatOwnsBody,
    entries: entries.map((entry) => ({ ...entry })),
  };
}

export function decideHostile(observed: HostileDanger): ResponseDecision<HostileResponse | ShieldPreparation> {
  if (observed.prepareShield && observed.directive.kind === "none" && !observed.settling && !observed.combatOwnsBody)
    return {
      kind: "respond",
      response: { kind: "prepare_shield" },
      name: "prepare_shield",
      reason: "Equip an available shield before nearby hostiles require a guard.",
    };
  return decideHostileReflex(observed);
}

/** What answers this response: the shield move is scoped to the off-hand, any other to its target and cell. */
export function hostileScope(scene: HostileScene, response: HostileResponse | ShieldPreparation): AnsweredScope {
  const { bot, policy } = scene;
  if (response.kind === "prepare_shield")
    return {
      capability: "combat.prepare_shield",
      response: "prepare_shield",
      scope: "off-hand",
      facts: () => ({
        offHand: bot.inventory.slots[45]?.name ?? null,
        shields: carriedShields(bot).map((item) => item.slot),
      }),
      permissions: () => ({ shield: policy.combat.shield }),
    };
  return responseScope(bot, () => policy.effective, response.kind, "targetId" in response ? response.targetId : undefined);
}
