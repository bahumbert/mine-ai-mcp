// Execute a hostile response from the seat and translate observed effects into the existing combat results.
import { Vec3 } from "vec3";
import { respondFromBoat } from "../../actions/navigate/boat-seated-response.js";
import { encounterBaseline, type HostileResponseResult } from "../control/combat/response-result.js";
import type { HostileResponse } from "../policy/combat/response.js";
import type { HostileScene } from "./hostile-scene.js";
import { currentVehicle } from "../../actions/navigate/vehicle-sync.js";
import { observedFireballReversal } from "../responses/deflect.js";
import { monotonicNow } from "../../utils/index.js";

interface Reflection {
  readonly incoming: Vec3 | null;
  reversed: boolean;
}

/** Contacts steer withdrawal; only the selected target authorizes strikes or completes its fight/deflection. */
function liveBoatThreats(scene: HostileScene, directive: HostileResponse, killed: ReadonlySet<number>, reflection: Reflection) {
  const { bot } = scene;
  const target = "targetId" in directive ? bot.entities[directive.targetId] : undefined;
  if (target && reflection.incoming && observedFireballReversal(target, reflection.incoming)) reflection.reversed = true;
  if (reflection.reversed || ("targetId" in directive && (!target?.isValid || killed.has(directive.targetId)))) return [];
  return directive.threats.flatMap((threat) => {
    const entity = bot.entities[threat.id];
    return entity?.isValid && !killed.has(threat.id) ? [{ id: threat.id, position: entity.position }] : [];
  });
}

/** Keep the boat at sea; hiding here is physical withdrawal, never a claimed enclosure. */
export async function respondToHostileFromBoat(
  scene: HostileScene, directive: HostileResponse, healthBefore: number, signal: AbortSignal,
): Promise<HostileResponseResult> {
  const { bot, policy } = scene;
  const startedAtMs = monotonicNow();
  const startPosition = { ...bot.entity.position };
  const firstDistances = new Map(encounterBaseline(bot, directive, healthBefore).finalDistances.map((entry) => [entry.id, entry.distance]));
  const killed = new Set<number>();
  const reflection: Reflection = { incoming: directive.kind === "deflect" ? bot.entities[directive.targetId]?.velocity.clone() ?? null : null, reversed: false };
  let explosions = 0;
  const onExplosion = () => { explosions++; };
  const onDead = (entity: typeof bot.entity) => { killed.add(entity.id); };
  bot.on("entityDead", onDead);
  bot._client.on("explosion", onExplosion);
  let outcome;
  try {
    outcome = await respondFromBoat(bot, () => liveBoatThreats(scene, directive, killed, reflection), signal, {
      policy: policy.combat,
      settleOnAbort: true,
      rowOnly: directive.kind === "evade" || directive.kind === "hide",
      ...("targetId" in directive ? { attackTargetId: directive.targetId } : {}),
      hostileRadius: directive.kind === "evade" ? directive.safeRange : policy.combat.evade_safe_range,
      ...(directive.kind === "evade" || directive.kind === "hide" ? { wallMs: policy.combat.evade_timeout_ms } : {}),
    });
  } finally {
    bot.off("entityDead", onDead);
    bot._client.off("explosion", onExplosion);
  }
  const common = {
    ...encounterBaseline(bot, directive, healthBefore), attacks: outcome.strikes,
    combatStyles: outcome.strikes ? ["melee" as const] : [], weaponsUsed: outcome.weaponsUsed,
    shieldRaisedSwings: 0, projectileGuards: 0, explosions,
    killedTargetIds: directive.threats.filter((threat) => killed.has(threat.id)).map((threat) => threat.id),
  };
  const observation = `${outcome.outcome}; rowed ${outcome.rowed.toFixed(1)} blocks, struck ${outcome.strikes} times; ${currentVehicle(bot) ? "still seated in its boat" : "no longer seated"}. Observe the threats before the next movement.`;
  if (directive.kind === "evade" || directive.kind === "hide") {
    const separated = directive.threats.every((threat) => killed.has(threat.id) ||
      (bot.entities[threat.id]?.position ?? new Vec3(threat.position.x, threat.position.y, threat.position.z))
        .distanceTo(bot.entity.position) >= policy.combat.evade_safe_range);
    const ends = directive.threats.map((threat) => {
      const distance = common.finalDistances.find((entry) => entry.id === threat.id)!.distance;
      const firstDistance = firstDistances.get(threat.id)!;
      return { id: threat.id, name: threat.name, firstDistance, firstSeen: "decision" as const, distance,
        gained: distance - firstDistance, advancing: null,
        basis: killed.has(threat.id) ? "dead" as const : distance >= policy.combat.evade_safe_range ? "range" as const : null };
    });
    return { ...common, response: "evade", startPosition, elapsedMs: monotonicNow() - startedAtMs,
      // The seated evade still counts real milliseconds (census ticket: a boat leg and its stop confirmation).
      elapsedTicks: null, goalRefreshes: 0,
      ends, result: separated ? { kind: "separated" } : { kind: "exhausted", reason: observation } };
  }
  if (directive.kind === "deflect")
    return { ...common, response: "deflect", result: { kind: reflection.reversed ? "reflected" : "unobserved", attacks: outcome.strikes,
      observation: reflection.reversed ? "Observed the fireball reverse its incoming direction." : observation } };
  const result = { targetId: directive.targetId, attacks: outcome.strikes, stylesUsed: common.combatStyles,
    weaponsUsed: common.weaponsUsed, shieldRaisedSwings: 0, projectileGuards: 0, explosions };
  return { ...common, response: "fight", result: killed.has(directive.targetId) ? { ...result, kind: "died" }
    : outcome.outcome === "clear" || outcome.outcome === "struck" || outcome.outcome === "rowed"
      ? { kind: "contact_ended" } : { ...result, kind: "failed", observation } };
}
