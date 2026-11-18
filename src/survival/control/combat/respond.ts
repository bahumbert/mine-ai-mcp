import type { Bot } from "mineflayer";
import { BodyAbort } from "../../../session/abort.js";
import { type NavigationRuntime } from "../../../navigation/index.js";
import { defendsOnContact, inDefensiveContact } from "../../perception/combat/contact.js";
import { decideCombatResponse, decideFightMovement } from "../../policy/combat/decision.js";
import { recoveryHealth } from "../../policy/combat/health.js";
import { responsePolicyChanged } from "../../policy/combat/permissions.js";
import type { HostileDirective, HostileResponse } from "../../policy/combat/response.js";
import { deflectFireball } from "../../responses/deflect.js";
import { evade } from "../../responses/evade.js";
import { hideInPlace } from "../../responses/hide.js";
import { contextPolicy, type ResponseContext } from "./context.js";
import type { CombatController, CombatOutcome } from "./contract.js";
import {
  encounterBaseline,
  type DeflectResponseResult,
  type FightResponseResult,
  type HideResponseResult,
  type HostileResponseResult,
} from "./response-result.js";
import { answeredResponses, responseScope } from "./scopes/response.js";
import { observeCombatDecision } from "./observation.js";
import { completeResponse, responseFailure } from "./settlement.js";
import { creeperEscape } from "../../policy/combat/tactics.js";
import { COMBAT_LIMITS } from "./limits.js";
import { watchEntityRemoval } from "../../../world/entity-removal.js";
import { monotonicNow } from "../../../utils/index.js";
import { MS_PER_ON_TIME_TICK, serverPacedWallMs, serverTickDeadline, type ServerTickDeadline } from "../../../world/world-age.js";

/**
 * Consecutive physics ticks a melee target may stay out of defensive reach before the fight ends as `contact_ended`.
 * A knockback flight lasts about 0.6 s (12 ticks, `facts/runtime-pitfalls.md` "a `/damage` attributed to an entity
 * knocks the bot back"); 20 ticks is one second, above it. The count lives on physics ticks only: with no tick the
 * fight's 30 s no-progress limit bounds it. A target that does not defend on contact (a bow holder) counts too when
 * the decision marked the fight `endsOnContactLoss`: it is a contact-only fight that withdrawal would have replaced
 * once the target left reach (P4-29 a5 C2); any other fight on such a target holds its shield until its limits.
 */
export const CONTACT_GRACE_TICKS = 20;

/**
 * Keep blast clearance during contact loss, but a missing quarry cannot hold the body beyond its stand-down window of
 * world ticks. The deadline is also read on time packets (they come with physics stopped) and a wall timer backs it
 * up; the packets never count towards the contact grace (plan 2026-11-16-reflex-limits-ticks D5).
 */
function watchFightContact(
  bot: Bot,
  request: Extract<HostileDirective, { kind: "fight" }>,
  context: ResponseContext,
  ended: AbortController,
): () => void {
  const targetId = request.targetId;
  const removal = watchEntityRemoval(bot, targetId);
  let readsOutOfReach = 0;
  let missing: { readonly deadline: ServerTickDeadline; readonly wallTimer: ReturnType<typeof setTimeout> } | undefined;
  const stopWaiting = () => {
    if (missing) clearTimeout(missing.wallTimer);
    missing = undefined;
  };
  const startWaiting = () => {
    stopWaiting();
    const wallMs = serverPacedWallMs(COMBAT_LIMITS.standDownTicks);
    // With no age heard yet the deadline is only `ticks * 50` ms (D1): the timer wakes at that, not at the wall.
    const wakeMs = bot.time?.age == null ? COMBAT_LIMITS.standDownTicks * MS_PER_ON_TIME_TICK : wallMs;
    missing = {
      deadline: serverTickDeadline(() => bot.time?.age ?? null, COMBAT_LIMITS.standDownTicks, monotonicNow(),
        { origin: "packet", wallMs, stoppedMs: null }),
      wallTimer: setTimeout(() => {
        missing = undefined;
        if (removal.removed()) ended.abort("target_lost");
      }, wakeMs),
    };
  };
  const endWaitWhenOver = () => {
    if (missing && removal.removed() && missing.deadline.passed(monotonicNow())) ended.abort("target_lost");
  };
  const observe = () => {
    const target = bot.entities[targetId];
    if (!removal.removed()) stopWaiting();
    else if (!missing) startWaiting();
    endWaitWhenOver();
    const { perception } = context;
    const creepers = perception.creeperClearance.observe(perception.tick, perception.resolvedIds);
    const endsOnLeavingReach = request.endsOnContactLoss === true || (target ? defendsOnContact(bot, target) : false);
    if (target?.isValid && endsOnLeavingReach && !inDefensiveContact(bot, target)) readsOutOfReach++;
    else readsOutOfReach = 0;
    if (creeperEscape({ creepers, clearancePending: perception.creeperClearance.pending, stationaryCommitment: false })) return;
    if (readsOutOfReach >= CONTACT_GRACE_TICKS) ended.abort("contact_ended");
  };
  // Each removal of the id starts its own wait: the same id may have come back and gone again between two reads.
  const onGone = (entity: { id: number }) => {
    if (entity.id !== targetId) return;
    stopWaiting();
    observe();
  };
  bot.on("physicsTick", observe);
  bot.on("entityGone", onGone);
  bot.on("time", endWaitWhenOver);
  observe();
  return () => {
    removal[Symbol.dispose]();
    stopWaiting();
    bot.off("physicsTick", observe);
    bot.off("entityGone", onGone);
    bot.off("time", endWaitWhenOver);
  };
}

async function fight(
  bot: Bot,
  controller: CombatController,
  request: Extract<HostileDirective, { kind: "fight" }>,
  context: ResponseContext,
  healthBefore: number,
  signal: AbortSignal,
): Promise<FightResponseResult> {
  const contactEnded = new AbortController();
  const policyRevision = controller.policy.snapshot().revision;
  const target = bot.entities[request.targetId];
  const stopWatching = watchFightContact(bot, request, context, contactEnded);
  let result: CombatOutcome;
  try {
    const pending = controller.engage(
      request.targetId,
      AbortSignal.any([signal, contactEnded.signal]),
      decideFightMovement({
        policy: controller.policy.combat,
        health: bot.health,
        target: target ? { name: target.name ?? "unknown", defendsOnContact: defendsOnContact(bot, target) } : null,
      }),
    );
    result = await pending;
  } finally {
    stopWatching();
  }
  // A settled controller still owns useful statistics after cancellation.
  // The claim owner classifies cancellation/death without discarding them.
  const common = {
    ...encounterBaseline(bot, request, healthBefore),
    attacks: result.attacks,
    combatStyles: result.stylesUsed,
    weaponsUsed: result.weaponsUsed,
    shieldRaisedSwings: result.shieldRaisedSwings,
    projectileGuards: result.projectileGuards,
    explosions: result.explosions,
  };
  return {
    ...common,
    response: "fight",
    killedTargetIds: result.kind === "died" ? [result.targetId] : [],
    result:
      result.kind === "cancelled" && contactEnded.signal.aborted && !signal.aborted
        ? contactEnded.signal.reason === "target_lost" ? { ...result, kind: "target_lost" } : { kind: "contact_ended" }
        : result.kind === "cancelled" && !signal.aborted && controller.policy.snapshot().revision === policyRevision
          ? { ...result, kind: "failed", observation: "Combat was cancelled without an aborted session signal." }
          : result,
  };
}

/** Reconsider one occupied shell using current premises, without reopening the failed construction. */
async function followOccupiedShelter(
  bot: Bot,
  navigation: NavigationRuntime,
  controller: CombatController,
  context: ResponseContext,
  healthBefore: number,
  signal: AbortSignal,
  why: string,
): Promise<HideResponseResult["followUp"]> {
  const policy = contextPolicy(context);
  context.survival.answered.remember(responseScope(bot, policy, "hide"), { kind: "enclosure_failed", why });
  signal.throwIfAborted();
  if (bot.health <= 0) return null;
  const facts = observeCombatDecision(bot, context);
  const next = decideCombatResponse({ ...facts,
    answered: new Set([...facts.answered, ...answeredResponses(bot, policy, context.survival), "hide"]),
  }, { kind: "automatic" });
  if (next.kind !== "fight" && next.kind !== "evade") return null;
  const changed = new AbortController();
  let previousPolicy = controller.policy.combat;
  const stopWatching = controller.policy.onChange(snapshot => {
    if (responsePolicyChanged(previousPolicy, controller.policy.combat, next.kind))
      changed.abort(new BodyAbort({ kind: "policy_changed", revision: snapshot.revision }, "Combat policy changed."));
    previousPolicy = controller.policy.combat;
  });
  const followUpSignal = AbortSignal.any([signal, changed.signal]);
  let physical: HostileResponseResult;
  try {
    physical = await executeHostileResponse(bot, navigation, controller, next, context, healthBefore, followUpSignal);
    followUpSignal.throwIfAborted();
  } finally {
    stopWatching();
  }
  if (physical.response !== "fight" && physical.response !== "evade") return null;
  const failure = responseFailure(completeResponse(physical, signal));
  if (failure && bot.health > 0) context.survival.answered.remember(
    responseScope(bot, policy, next.kind, next.kind === "fight" ? next.targetId : undefined), failure,
    next.kind === "fight" ? { premise: "unreachable", ticks: COMBAT_LIMITS.noProgressTicks, why: failure.why } : null);
  return physical;
}

async function hide(
  bot: Bot,
  navigation: NavigationRuntime,
  controller: CombatController,
  request: Extract<HostileDirective, { kind: "hide" }>,
  context: ResponseContext,
  healthBefore: number,
  signal: AbortSignal,
): Promise<HideResponseResult> {
  const result = await hideInPlace(bot, {
    navigation,
    signal,
    threatContext: context,
    recoverTo: recoveryHealth(context.policy),
    maximumMs: context.policy.recovery_timeout_ms,
  });
  signal.throwIfAborted();
  const followUp = bot.health > 0 && result.kind === "failed" && result.refusal?.cause === "occupied"
    ? await followOccupiedShelter(bot, navigation, controller, context, healthBefore, signal, result.error) : null;
  return {
    ...encounterBaseline(bot, request, healthBefore),
    response: "hide",
    result,
    followUp,
    attacks: 0,
    combatStyles: [],
    weaponsUsed: [],
    shieldRaisedSwings: 0,
    projectileGuards: 0,
    explosions: 0,
    killedTargetIds: [],
  };
}

async function deflect(
  bot: Bot,
  request: Extract<HostileResponse, { kind: "deflect" }>,
  context: ResponseContext,
  healthBefore: number,
  signal: AbortSignal,
): Promise<DeflectResponseResult> {
  let explosions = 0;
  const onExplosion = () => {
    explosions += 1;
  };
  bot._client.on("explosion", onExplosion);
  try {
    const result = await deflectFireball(bot, request.targetId, signal, context);
    return {
      ...encounterBaseline(bot, request, healthBefore),
      response: "deflect",
      result,
      attacks: result.attacks,
      killedTargetIds: [],
      combatStyles: result.attacks > 0 ? ["melee"] : [],
      weaponsUsed: result.attacks > 0 ? [bot.heldItem?.name ?? "hand"] : [],
      shieldRaisedSwings: 0,
      projectileGuards: 0,
      explosions,
    };
  } finally {
    bot._client.off("explosion", onExplosion);
  }
}

/** Execute one selected response. The claim owner classifies interruption after effects settle. */
export async function executeHostileResponse(
  bot: Bot,
  navigation: NavigationRuntime,
  controller: CombatController,
  request: HostileResponse,
  context: ResponseContext,
  healthBefore: number,
  signal: AbortSignal,
): Promise<HostileResponseResult> {
  signal.throwIfAborted();
  switch (request.kind) {
    case "deflect":
      return deflect(bot, request, context, healthBefore, signal);
    case "fight":
      return fight(bot, controller, request, context, healthBefore, signal);
    case "hide":
      return hide(bot, navigation, controller, request, context, healthBefore, signal);
    case "evade":
      return evade(bot, navigation, request, context, healthBefore, signal);
  }
}

/** A combat request keeps ownership and retains an unobserved deflection before reconsidering. */
export async function deflectWithinCombat(bot: Bot, targetId: number, context: ResponseContext, signal: AbortSignal) {
  const scope = responseScope(bot, contextPolicy(context), "deflect", targetId);
  const result = await deflectFireball(bot, targetId, signal, context);
  signal.throwIfAborted();
  if (result.kind !== "reflected")
    context.survival.answered.remember(scope, { kind: "deflection_unobserved", why: result.observation });
  return result;
}
