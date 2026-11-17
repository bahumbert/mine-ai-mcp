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
import { COMBAT_LIMITS } from "../control/combat/limits.js";
import type { ReflexDriver } from "../control/driver.js";
import { changes, watchBodyTicks } from "../control/reflex-progress.js";
import type { CombatPerception } from "../perception/combat/observations.js";
import { responsePolicyChanged } from "../policy/combat/permissions.js";
import type { HostileResponse } from "../policy/combat/response.js";
import { messageOf, offHandItem, type HostileScene } from "./hostile-scene.js";
import { prepareShield, respondToHostile, type ShieldPrepared } from "./hostile-respond.js";
import { decideHostile, heldThreatEnded, hostileDecisionFacts, hostileScope, senseHostile } from "./hostile-sense.js";
import { ThreatChains } from "../state/threat-chains.js";


export const HOSTILE_REFLEX = "hostile_reflex" as const;

/** Equipping a shield is one inventory move: 200 world ticks (10 s) at most, 100 without the off-hand changing. */
const SHIELD_LIMITS: ReflexLimits = { ceilingTicks: 200, noProgressTicks: 100, standDownTicks: 200 };

export interface HostileReflex extends AsyncDisposable {
  readonly threats: ResponseContext;
  activeResponse(): HostileResponse["kind"] | null;
}

/** Cancel changed response permissions and reset encounter policy at death or a dimension change. */
function watchHostilePolicy(scene: HostileScene): () => void {
  const { bot, policy, driver, encounterThreats, transition } = scene;
  let previousPolicy = policy.combat;
  let previousFood = policy.food;
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
    scene.chains.clear();
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
  return () => {
    unsubscribePolicy();
    bot.off("death", resetPolicy);
    bot.off("game", dimensionChanged);
  };
}

/** A failed fight or deflection is a target standoff for the same window that judges combat progress. */
function hostileFailureTemporal(outcome: HostileSettlement | ShieldPrepared) {
  if (outcome.kind === "shield_prepared" || (outcome.response !== "fight" && outcome.response !== "deflect")) return null;
  const failure = responseFailure(outcome);
  return failure ? { premise: "unreachable", ticks: COMBAT_LIMITS.noProgressTicks, why: failure.why } : null;
}

/** Keep response permissions live while sharing perception and the driver's retained answers. */
function hostileResponseContext(bot: Bot, driver: ReflexDriver, controller: CombatController,
  perception: CombatPerception): ResponseContext {
  const policy = controller.policy;
  return {
    perception,
    resolvedIds: perception.resolvedIds,
    attackerIds: perception.attackerIds,
    survival: driver,
    get policy() { return policy.combat; },
    get food() { return policy.food; },
    get blockedResponses() { return answeredResponses(bot, () => policy.effective, driver); },
  };
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
  const encounterThreats = new Set<number>();
  let closing: Promise<void> | null = null;

  const context = hostileResponseContext(bot, driver, controller, perception);

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
    chains: new ThreatChains(),
    transition,
    activeResponse: null,
  };

  const stopWatchingPolicy = watchHostilePolicy(scene);

  const registration = driver.register({
    name: HOSTILE_REFLEX,
    seated: true,
    sense: () => senseHostile(scene),
    decisionFacts: hostileDecisionFacts,
    decide: decideHostile,
    heldEnded: (held, observed, decision) => held.kind !== "prepare_shield" && (decision === "none_observed" ||
      typeof decision === "object" && decision !== null && "kind" in decision && decision.kind === "handled" &&
      "by" in decision && decision.by === "no_contact") ? heldThreatEnded(scene, held, observed) : null,
    facts: (response) => hostileScope(scene, response),
    limits: (response) => (response.kind === "prepare_shield" ? SHIELD_LIMITS : COMBAT_LIMITS),
    bodyTravel: (response) => response.kind !== "fight",
    escalateStandDown: (response) => response.kind === "fight",
    progress: (response, mark) => {
      if (response.kind === "prepare_shield")
        return watchBodyTicks(bot, mark, { off_hand_changed: changes(() => offHandItem(bot)) });
      const stopPhysical = observeCombatProgress(bot, response.threats.map(threat => threat.id), mark, response.kind);
      // A live fight owns the no-hit bound, including guard/recovery pauses. The driver's ceiling and stopped-body
      // watchdog remain backstops; fights without this budget retain the ordinary no-progress watchdog.
      const stopQuarry = response.kind === "fight" ? watchBodyTicks(bot, mark, {
        quarry_bound_active: () => driver.budgets.snapshot().some(budget =>
          budget.name === "quarry_progress" && budget.scope === `target:${response.targetId}`),
      }) : () => {};
      return () => { stopQuarry(); stopPhysical(); };
    },
    act: (directive, signal): Promise<HostileSettlement | ShieldPrepared> =>
      directive.kind === "prepare_shield" ? prepareShield(scene, signal) : respondToHostile(scene, directive, signal),
    continuation: (outcome) => outcome.kind === "shield_prepared" ? { kind: "resume" } : responseContinuation(outcome),
    failure: (outcome) => outcome.kind === "shield_prepared" ? (outcome.error ? { kind: "equip_failed", why: outcome.error } : null) : responseFailure(outcome),
    temporal: hostileFailureTemporal,
    describe: (outcome) => outcome.kind === "shield_prepared" ? { kind: outcome.kind, equipped: outcome.equipped, error: outcome.error } : describeResponse(outcome),
  });

  return {
    threats: context,
    activeResponse: () => scene.activeResponse,
    [Symbol.asyncDispose]: () =>
      (closing ??= (async () => {
        stopWatchingPolicy();
        await registration[Symbol.asyncDispose]();
        await controller.stop("hostile contact observer closed");
      })()),
  };
}
