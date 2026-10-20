import { isDeepStrictEqual } from "node:util";
import type { Bot } from "mineflayer";
import type { NavigationRuntime } from "../../navigation/index.js";
import { BodyAbort } from "../../session/abort.js";
import type { ResponseContext } from "../control/combat/context.js";
import type { CombatController } from "../control/combat/contract.js";
import { answeredResponses } from "../control/combat/scopes/response.js";
import type { HostileSettlement } from "../control/combat/response-result.js";
import { describeResponse, responseContinuation, responseFailure } from "../control/combat/settlement.js";
import type { ReflexLimits } from "../control/contract.js";
import { observeCombatProgress } from "../control/combat-progress.js";
import type { ReflexDriver } from "../control/driver.js";
import { changes, watchBodyTicks } from "../control/reflex-progress.js";
import type { CombatPerception } from "../perception/combat/observations.js";
import { responsePolicyChanged } from "../policy/combat/permissions.js";
import type { HostileResponse } from "../policy/combat/response.js";
import { messageOf, offHandItem, type HostileScene } from "./hostile-scene.js";
import { prepareShield, respondToHostile, type ShieldPrepared } from "./hostile-respond.js";
import { decideHostile, hostileDecisionFacts, hostileScope, senseHostile } from "./hostile-sense.js";


export const HOSTILE_REFLEX = "hostile_reflex" as const;

/** A fight, evade, hide or deflect may hold the body 10 min; 30 s without a combat progress mark ends it; its target (or cell) then stands down 10 s (owner 2026-10-19). */
const COMBAT_LIMITS: ReflexLimits = { ceilingMs: 600_000, noProgressMs: 30_000, standDownMs: 10_000 };
/** Equipping a shield is one inventory move: 10 s at most, 5 s without the off-hand changing. */
const SHIELD_LIMITS: ReflexLimits = { ceilingMs: 10_000, noProgressMs: 5_000, standDownMs: 10_000 };

export interface HostileReflex extends AsyncDisposable {
  readonly threats: ResponseContext;
  activeResponse(): HostileResponse["kind"] | null;
}

/** Hostile observations and execution; admission, cancellation and failure retention belong to the driver. */
export function attachHostileReflex(
  bot: Bot,
  driver: ReflexDriver,
  navigation: NavigationRuntime,
  controller: CombatController,
  perception: CombatPerception,
): HostileReflex {
  const policy = controller.policy;
  const { resolvedIds, attackerIds } = perception;
  const encounterThreats = new Set<number>();
  let previousPolicy = policy.combat;
  let previousFood = policy.food;
  let closing: Promise<void> | null = null;

  const context: ResponseContext = {
    perception,
    resolvedIds,
    attackerIds,
    survival: driver,
    get policy() {
      return policy.combat;
    },
    get food() {
      return policy.food;
    },
    unreachableIds: new Set(),
    get blockedResponses() {
      return answeredResponses(bot, () => policy.effective, driver);
    },
  };

  const transition = (pending: Promise<void>) => {
    void pending.catch((cause) => policy.constrain(messageOf(cause)));
  };

  const scene: HostileScene = {
    bot,
    driver,
    navigation,
    controller,
    perception,
    policy,
    context,
    encounterThreats,
    transition,
    activeResponse: null,
  };

  const unsubscribePolicy = policy.onChange(async (snapshot) => {
    const changed = scene.activeResponse && (
      responsePolicyChanged(previousPolicy, policy.combat, scene.activeResponse) ||
      (scene.activeResponse === "hide" && !isDeepStrictEqual(previousFood, policy.food))
    );
    previousPolicy = policy.combat;
    previousFood = policy.food;
    if (changed)
      await driver.cancel(
        HOSTILE_REFLEX,
        new BodyAbort({ kind: "policy_changed", revision: snapshot.revision }, "Combat policy changed."),
      );
  });
  const resetPolicy = () => {
    encounterThreats.clear();
    transition(policy.reset("Death or dimension change; defaults restored."));
  };
  bot.on("death", resetPolicy);
  let dimension = bot.game.dimension;
  const dimensionChanged = () => {
    if (dimension === bot.game.dimension) return;
    dimension = bot.game.dimension;
    resetPolicy();
  };
  bot.on("game", dimensionChanged);

  const registration = driver.register({
    name: HOSTILE_REFLEX,
    sense: () => senseHostile(scene),
    decisionFacts: hostileDecisionFacts,
    decide: decideHostile,
    facts: (response) => hostileScope(scene, response),
    limits: (response) => (response.kind === "prepare_shield" ? SHIELD_LIMITS : COMBAT_LIMITS),
    progress: (response, mark) =>
      response.kind === "prepare_shield"
        ? watchBodyTicks(bot, mark, { off_hand_changed: changes(() => offHandItem(bot)) })
        : observeCombatProgress(bot, response.threats.map((threat) => threat.id), mark),
    act: (directive, signal): Promise<HostileSettlement | ShieldPrepared> =>
      directive.kind === "prepare_shield" ? prepareShield(scene, signal) : respondToHostile(scene, directive, signal),
    continuation: (outcome) => outcome.kind === "shield_prepared" ? { kind: "resume" } : responseContinuation(outcome),
    failure: (outcome) => outcome.kind === "shield_prepared" ? (outcome.error ? { kind: "equip_failed", why: outcome.error } : null) : responseFailure(outcome),
    describe: (outcome) => outcome.kind === "shield_prepared" ? { kind: outcome.kind, equipped: outcome.equipped, error: outcome.error } : describeResponse(outcome),
  });

  return {
    threats: context,
    activeResponse: () => scene.activeResponse,
    [Symbol.asyncDispose]: () =>
      (closing ??= (async () => {
        unsubscribePolicy();
        bot.off("death", resetPolicy);
        bot.off("game", dimensionChanged);
        await registration[Symbol.asyncDispose]();
        await controller.stop("hostile contact observer closed");
      })()),
  };
}
