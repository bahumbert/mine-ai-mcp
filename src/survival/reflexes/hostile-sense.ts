// What the hostile reflex senses each tick: the contacts, the combat decision, and the answered responses.
import { observeCombatDecision } from "../control/combat/observation.js";
import { responseScope } from "../control/combat/scopes/response.js";
import { recoveryScope } from "../control/combat/scopes/recovery.js";
import type { AnsweredScope, Facts } from "../state/answered.js";
import { incomingFireball } from "../perception/combat/fireball.js";
import { incomingShieldProjectiles } from "../perception/combat/shield-projectiles.js";
import { HOSTILE_OBSERVATION_RANGE, isHostile, observeHostileContact } from "../perception/combat/threats.js";
import { combatDecisionEvidence, decideCombatResponse } from "../policy/combat/decision.js";
import { recoveryHealth } from "../policy/combat/health.js";
import type { HostileResponse } from "../policy/combat/response.js";
import type { HeldThreatEnd, ResponseDecision } from "../control/contract.js";
import { decideHostileReflex } from "../policy/combat/reflex-decision.js";
import { OFF_HAND_SLOT, shieldInOffHand } from "../weapons/equipment.js";
import { carriedShields, type HostileScene } from "./hostile-scene.js";
import { isBoatEntity } from "../../actions/navigate/boat-entities.js";
import { currentVehicle } from "../../actions/navigate/vehicle-sync.js";
import { atSeaFrom } from "../../actions/navigate/boat-at-sea.js";

const seatObservations = new WeakMap<HostileScene, {
  readonly seat: ReturnType<typeof currentVehicle>;
  readonly response: HostileScene["activeResponse"];
  readonly range: number;
  readonly cell: string;
  readonly atSea: boolean;
}>();

/** Shore scans run once per observed seat cell/response, never on foot or repeatedly at the same seat cell. */
function seatedOutAtSea(scene: HostileScene): boolean {
  const seat = currentVehicle(scene.bot);
  if (!seat || !isBoatEntity(seat)) {
    seatObservations.delete(scene);
    return false;
  }
  const range = scene.policy.combat.evade_safe_range;
  const cell = seat.position.floored().toString();
  const previous = seatObservations.get(scene);
  if (previous?.seat === seat && previous.cell === cell && previous.response === scene.activeResponse && previous.range === range) return previous.atSea;
  const atSea = atSeaFrom(scene.bot, seat.position, range);
  seatObservations.set(scene, { seat, response: scene.activeResponse, range, cell, atSea });
  return atSea;
}

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
  else if (policy.encounter) {
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
  const observed = observeCombatDecision(bot, scene.context);
  // A seated withdrawal rows; it cannot promise a shelter or protected recovery (P4-06c T10b, 2026-11-09).
  const facts = { ...observed, hideAllowed: observed.hideAllowed && !seatedOutAtSea(scene) };
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

/** A non-response can resume a held walk only when the current observations show its threat ended. */
export function heldThreatEnded(scene: HostileScene, held: HostileResponse, observed: HostileDanger | null): HeldThreatEnd {
  // A still-incoming projectile beyond the contact range must not buy a short resume between responses.
  const fireball = incomingFireball(scene.bot, Infinity);
  if (fireball) return { notEnded: `projectile ${fireball.name}#${fireball.id} incoming at ${fireball.position.distanceTo(scene.bot.entity.position).toFixed(1)}` };
  const shieldProjectile = incomingShieldProjectiles(scene.bot)[0];
  if (shieldProjectile) return { notEnded: `shield projectile ${shieldProjectile.name}#${shieldProjectile.id}` };
  if (observed === null) return { ended: "no projectile in flight, no hostile tracked" };
  const targets = "targetId" in held ? [{ id: held.targetId,
    name: held.threats.find((threat) => threat.id === held.targetId)?.name ?? scene.bot.entities[held.targetId]?.name ?? "entity" }]
    : held.threats;
  if (!targets.length) return { notEnded: "hostile tracked" };
  const alive = targets.find(({ id }) => !scene.perception.resolvedIds.has(id) && scene.bot.entities[id]?.isValid && held.kind !== "deflect");
  if (alive) return { notEnded: `target ${alive.name}#${alive.id} alive` };
  return { ended: ["no projectile in flight", ...targets.map(({ id, name }) =>
    `target ${name}#${id} ${scene.perception.resolvedIds.has(id) ? "dead" : scene.bot.entities[id]?.isValid ? "passed" : "gone"}`)].join(", ") };
}

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
        offHand: bot.inventory.slots[OFF_HAND_SLOT]?.name ?? null,
        shields: carriedShields(bot).map((item) => item.slot),
      }),
      permissions: () => ({ shield: policy.combat.shield }),
    };
  return responseScope(bot, () => policy.effective, response.kind, "targetId" in response ? response.targetId : undefined);
}
