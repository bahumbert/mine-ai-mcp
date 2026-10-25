import type { Bot } from "mineflayer";
import { eatFood } from "../../actions/eat-food/eat-food.js";
import type { CombatController } from "../control/combat/contract.js";
import type { ReflexLimits } from "../control/contract.js";
import type { ReflexDriver } from "../control/driver.js";
import { fallsUnder, risesOver, watchBodyTicks } from "../control/reflex-progress.js";
import { selectPolicyFood } from "../perception/food.js";
import { BodyAbort } from "../../session/abort.js";
import { isRawFood } from "../../world/food.js";
import { rawFoodPermitted } from "../policy/food.js";
import type { SurvivalPolicyState } from "../state/survival-policy.js";
import { decideHungerResponse, needsFood } from "../policy/environment.js";

/** What the runner reports as the body's owner while the bot eats. */
export const HUNGER_REFLEX = "hunger_reflex" as const;
const CHECK_INTERVAL_TICKS = 20;
/** A meal is a few seconds; 8 s without a bite, food gained or a stack spent ends it, then a 2 s pause (owner 2026-10-19). */
const HUNGER_LIMITS: ReflexLimits = { ceilingMs: 20_000, noProgressMs: 8_000, standDownMs: 2_000 };

/** What counts as getting somewhere during a meal: food or saturation rose, the stack shrank, a bite is in progress. */
function mealProgress(bot: Bot, food: string, mark: (reason: string) => void): () => void {
  const carried = () => bot.inventory.items().filter((item) => item.name === food).reduce((sum, item) => sum + item.count, 0);
  return watchBodyTicks(bot, mark, {
    food_rose: risesOver(() => bot.food),
    saturation_rose: risesOver(() => bot.foodSaturation),
    food_spent: fallsUnder(carried),
    biting: () => bot.usingHeldItem === true,
  });
}

/** Hungry enough to eat (or wounded enough to need the regeneration), with what the policy lets the bot eat now. */
function senseHunger(
  bot: Bot,
  driver: ReflexDriver,
  combat: Pick<CombatController, "activeEngagement">,
  policy: SurvivalPolicyState,
) {
  if (policy.settling || !needsFood(bot.health, bot.food)) return null;
  const owner = driver.runner.status().owner;
  const bodyBusy = owner === "takeover" || owner === "yielding";
  const combatActive = combat.activeEngagement() !== null;
  const selection = bodyBusy || combatActive ? null : selectPolicyFood(bot, policy.food);
  const facts = {
    food: bot.food,
    health: bot.health,
    selectedFood: selection?.food?.name ?? null,
    withheldRaw: selection?.withheld?.name ?? null,
    rawFoodRule: selection?.withheld ? selection.verdict.reason : null,
    bodyBusy,
    combatActive,
  };
  return { kind: "observed" as const, danger: facts, evidence: facts };
}

/** Eating yields to active combat, including combat owned by a model request. */
export function attachHungerReflex(
  bot: Bot,
  driver: ReflexDriver,
  combat: Pick<CombatController, "activeEngagement">,
  policy: SurvivalPolicyState,
): AsyncDisposable {
  let activeFood: string | null = null;
  const registration = driver.register({
    name: HUNGER_REFLEX,
    // Eating needs packets and a wall-clock bound, not physics: it goes on in a boat.
    seated: true,
    intervalTicks: CHECK_INTERVAL_TICKS,
    sense: () => senseHunger(bot, driver, combat, policy),
    decide: decideHungerResponse,
    facts: (food) => ({
      capability: "hunger",
      response: "eat",
      scope: `food:${food}`,
      facts: () => ({
        hunger: bot.food,
        food: bot.inventory
          .items()
          .filter((item) => item.name === food)
          .map((item) => item.count),
      }),
      permissions: () => isRawFood(food) ? { ...policy.food.raw } : null,
    }),
    limits: () => HUNGER_LIMITS,
    progress: (food, mark) => mealProgress(bot, food, mark),
    act: async (food, signal) => {
      // A policy edit can land after sensing but before body admission.
      if (isRawFood(food) && !rawFoodPermitted(policy.food.raw, { health: bot.health, hunger: bot.food }).permitted)
        throw new BodyAbort({ kind: "policy_changed", revision: policy.snapshot().revision }, "Food policy revoked this meal.");
      const hungerBefore = bot.food;
      const saturationBefore = bot.foodSaturation;
      activeFood = food;
      const result = await eatFood(bot, { foodName: food }, { signal }).finally(() => {
        activeFood = null;
      });
      return {
        kind: result.eating.consumed ? ("ate" as const) : ("eating_failed" as const),
        food,
        hungerBefore,
        hungerAfter: bot.food,
        saturationBefore,
        saturationAfter: bot.foodSaturation,
        error: result.status === "succeeded" ? null : result.error,
      };
    },
    continuation: () => ({ kind: "resume" }),
    failure: (outcome) =>
      outcome.kind === "eating_failed"
        ? { kind: outcome.kind, why: outcome.error ?? "Food consumption was not observed." }
        : null,
    describe: (outcome) => outcome,
  });
  const unsubscribe = policy.onChange(async (snapshot) => {
    if (activeFood === null || !isRawFood(activeFood)) return;
    if (rawFoodPermitted(policy.food.raw, { health: bot.health, hunger: bot.food }).permitted) return;
    await driver.cancel(HUNGER_REFLEX,
      new BodyAbort({ kind: "policy_changed", revision: snapshot.revision }, "Food policy revoked this meal."));
  });
  return {
    [Symbol.asyncDispose]: async () => {
      unsubscribe();
      await registration[Symbol.asyncDispose]();
    },
  };
}
