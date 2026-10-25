// What the hostile reflex does once it holds the body: equip a shield, or execute the directed response and settle it.
import type { Bot, BotEvents } from "mineflayer";
import { prepareBotForMovement } from "../../session/prepare-body.js";
import { executeHostileResponse } from "../control/combat/respond.js";
import { encounterBaseline, type EncounterEvidence, type HostileSettlement } from "../control/combat/response-result.js";
import { completeResponse } from "../control/combat/settlement.js";
import type { HostileResponse } from "../policy/combat/response.js";
import { carriedShields, messageOf, shieldInOffHand, type HostileScene } from "./hostile-scene.js";

/** Hits the reflex's preparation spends taking back a boat she stands on (about 4.5 s): a mob attacks meanwhile, and the next movement action takes it back with the full time bound (run 20). */
const HOSTILE_TAKE_BACK_HITS = 15;

export type ShieldPrepared = { readonly kind: "shield_prepared"; readonly equipped: boolean; readonly error: string | null };

/** Put an available shield in the off-hand; a failure is the outcome, not an exception. */
export async function prepareShield(scene: HostileScene, signal: AbortSignal): Promise<ShieldPrepared> {
  const { bot, policy } = scene;
  let error: string | null = null;
  try {
    signal.throwIfAborted();
    const shield = policy.combat.shield && !bot.usingHeldItem && !bot.currentWindow && !shieldInOffHand(bot) ? carriedShields(bot)[0] : undefined;
    if (shield) {
      await bot.equip(shield, "off-hand");
      if (!shieldInOffHand(bot)) error = "Shield equip did not settle in the off-hand.";
    }
  } catch (cause) {
    error = messageOf(cause);
  }
  return { kind: "shield_prepared", equipped: shieldInOffHand(bot), error };
}

/** Where and how far from each loaded entity the bot was at its death, taken at the first `death` event. */
function deathCapture(bot: Bot) {
  const death: {
    value: { position: EncounterEvidence["finalPosition"]; health: number; distances: Map<number, number> } | null;
  } = { value: null };
  const capture = () => {
    death.value ??= {
      position: { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z },
      health: bot.health,
      distances: new Map(
        Object.values(bot.entities).map((entity) => [entity.id, entity.position.distanceTo(bot.entity.position)]),
      ),
    };
  };
  return { death, capture };
}

/** The settlement of a response that threw or was aborted before it produced one. */
function abandonedEvidence(
  bot: Bot,
  directive: HostileResponse,
  healthBefore: number,
  cause: unknown,
  signal: AbortSignal,
): HostileSettlement {
  return {
    response: directive.kind,
    kind: signal.aborted && cause === signal.reason ? "cancelled" : "failed",
    reason: messageOf(cause),
    physical: null,
    evidence: {
      ...encounterBaseline(bot, directive, healthBefore),
      killedTargetIds: [],
      attacks: 0,
      combatStyles: [],
      weaponsUsed: [],
      shieldRaisedSwings: 0,
      projectileGuards: 0,
      explosions: 0,
    },
  };
}

/** A settlement rewritten for a bot that died during the response, with the distances at the moment of death. */
function diedDuring(
  settlement: HostileSettlement,
  atDeath: NonNullable<ReturnType<typeof deathCapture>["death"]["value"]>,
): HostileSettlement {
  const evidence = settlement.evidence;
  return {
    ...settlement,
    kind: "bot_died",
    reason: "The bot died during this response.",
    evidence: {
      ...evidence,
      healthAfter: atDeath.health,
      finalPosition: atDeath.position,
      finalDistances: evidence.threats.map((threat) => ({
        id: threat.id,
        distance:
          atDeath.distances.get(threat.id) ??
          Math.hypot(
            threat.position.x - atDeath.position.x,
            threat.position.y - atDeath.position.y,
            threat.position.z - atDeath.position.z,
          ),
      })),
    },
  };
}

/** Execute one directed response with the body, and settle it: died, cancelled, or what the physical response did. */
export async function respondToHostile(
  scene: HostileScene,
  directive: HostileResponse,
  signal: AbortSignal,
): Promise<HostileSettlement> {
  const { bot, policy, navigation, controller, context, perception } = scene;
  const { resolvedIds, attackerIds } = perception;
  scene.activeResponse = directive.kind;
  policy.observeResponse({
    kind: directive.kind,
    revision: policy.snapshot().revision,
    reason: directive.kind === "fight" ? "Permitted response to hostile contact." : directive.reason,
  });
  const healthBefore = bot.health;
  const { death, capture } = deathCapture(bot);
  const answeredAttackers = new Set(
    directive.threats.filter((threat) => attackerIds.has(threat.id)).map((threat) => threat.id),
  );
  const preserveNewAttack: BotEvents["entityHurt"] = (entity, source) => {
    if (entity.id === bot.entity.id && source) answeredAttackers.delete(source.id);
  };
  bot.on("death", capture);
  if (directive.kind === "evade") bot.on("entityHurt", preserveNewAttack);
  try {
    let settlement: HostileSettlement;
    try {
      signal.throwIfAborted();
      await prepareBotForMovement(bot, navigation, signal, { takeBackHits: HOSTILE_TAKE_BACK_HITS });
      signal.throwIfAborted();
      const physical = await executeHostileResponse(bot, navigation, controller, directive, context, healthBefore, signal);
      settlement = completeResponse(physical, signal);
    } catch (cause) {
      settlement = abandonedEvidence(bot, directive, healthBefore, cause, signal);
    }
    if (death.value) return diedDuring(settlement, death.value);
    if (signal.aborted && settlement.kind !== "failed")
      return { ...settlement, kind: "cancelled", reason: messageOf(signal.reason) };
    for (const id of settlement.evidence.killedTargetIds) {
      resolvedIds.add(id);
      attackerIds.delete(id);
    }
    if (settlement.physical?.response === "evade" && settlement.physical.result.kind === "separated")
      for (const id of answeredAttackers) attackerIds.delete(id);
    return settlement;
  } finally {
    bot.off("death", capture);
    bot.off("entityHurt", preserveNewAttack);
    scene.activeResponse = null;
    policy.observeResponse(null);
  }
}
