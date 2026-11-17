import { incomingShieldProjectiles } from "../perception/combat/shield-projectiles.js";
import type { Bot } from "mineflayer";
import { eatFood } from "../../actions/eat-food/eat-food.js";
import { monotonicNow } from "../../utils/index.js";
import { REGENERATION_HUNGER } from "../../world/food.js";
import { carriedCount } from "../../world/inventory-count.js";
import { recoveryScope } from "../control/combat/scopes/recovery.js";
import { fireContactCells, isInFire, isInLava } from "../perception/body.js";
import { selectPolicyFood } from "../perception/food.js";
import { hasRegeneration } from "../perception/combat/recovery.js";
import type { SurvivalPolicy } from "../policy/contract.js";
import { type SurvivalResources } from "../state/resources.js";
import type { Vec3 } from "vec3";

/** The first term that makes the recovery position unusable, in the order the hold checks them. */
type Hazard = "open" | "burning" | "molten" | "projectile";

export type CoveredRecovery =
  | { readonly kind: "recovered"; readonly ate: string | null }
  | { readonly kind: "exposed"; readonly ate: string | null }
  /** Health is still short, and the hold has said why it stopped waiting. */
  | {
      readonly kind: "held";
      readonly ate: string | null;
      readonly stop: "exhausted" | "unavailable" | "eating_failed" | "answered" | "prohibited" | "death";
      readonly reason: string;
    };

export interface CoveredRecoveryOptions {
  readonly signal: AbortSignal;
  readonly recoverTo: number;
  readonly maximumMs: number;
  readonly isProtected: () => boolean;
  /** A shelter can contain knockback without making it safe to open yet. */
  readonly holdWhile?: () => boolean;
  /**
   * Digs a fire out of a cell of the bot's own shell. Given only by a caller that may dig there: `blocked` leaves the
   * fire, and the recovery is exposed. Without it a fire is a hazard like lava.
   */
  readonly extinguish?: (cell: Vec3) => Promise<"clear" | "blocked">;
  readonly defendIntruder: () => Promise<void>;
  /** Intruder defence may have raised a shield since this hold began. */
  readonly releaseItemUse: () => void;
  readonly wait: (ticks: number) => Promise<void>;
  readonly survival: SurvivalResources;
  readonly policy: () => Readonly<Pick<SurvivalPolicy, "combat" | "food">>;
}

/**
 * One pass of the hold's meal: the food the policy allows, one bite of it, and how the pass ends. `end` is null when the
 * hold goes on to its wait, `"leave"` when there is nothing left to wait for, and otherwise the hold's result.
 */
async function eatInHold(
  bot: Bot,
  options: CoveredRecoveryOptions,
  ate: string | null,
  hazardNow: () => Hazard | null,
  unlessCleared: () => Promise<Hazard | null>,
  held: (stop: "unavailable" | "eating_failed", reason: string) => CoveredRecovery,
): Promise<{ readonly ate: string | null; readonly end: CoveredRecovery | "leave" | null }> {
  const selection = selectPolicyFood(bot, options.policy().food);
  const food = selection.food;
  if (!food) {
    if (bot.health < options.recoverTo)
      return {
        ate,
        end: held(
          "unavailable",
          selection.withheld
            ? `nothing carried may be eaten: only uncooked ${selection.withheld.name} is carried and ${selection.verdict.reason}`
            : `nothing carried can restore it: no food, and hunger ${bot.food} is below the regeneration bar`,
        ),
      };
    return { ate, end: options.holdWhile?.() ? null : "leave" };
  }
  let meal = ate;
  const exposed = new AbortController();
  const beforeEating = carriedCount(bot, food.name);
  const observe = () => {
    if (hazardNow() !== null && !exposed.signal.aborted) {
      exposed.abort("Recovery position became unsafe while eating.");
      // This owner must stop the bite before returning to shield or contact defence.
      if (bot.usingHeldItem) bot.deactivateItem();
    }
  };
  bot.on("physicsTick", observe);
  try {
    options.releaseItemUse();
    const eaten = await eatFood(
      bot,
      { foodName: food.name },
      { signal: AbortSignal.any([options.signal, exposed.signal]) },
    );
    if (eaten.status === "succeeded") meal = food.name;
    else if (!exposed.signal.aborted) return { ate: meal, end: held("eating_failed", `eating ${food.name} failed: ${eaten.error}`) };
  } catch (cause) {
    options.signal.throwIfAborted();
    if (!exposed.signal.aborted) throw cause;
    // Consumption can be observed in the same packet turn as lost cover.
    if (carriedCount(bot, food.name) < beforeEating) meal = food.name;
  } finally {
    bot.off("physicsTick", observe);
  }
  if (!exposed.signal.aborted) return { ate: meal, end: null };
  // A bite stopped by a fire is resumed once the fire is out; any other hazard ends the hold here.
  return (await unlessCleared()) ? { ate: meal, end: { kind: "exposed", ate: meal } } : { ate: meal, end: null };
}

/**
 * Eat and recover only while the owning position remains usable. Construction
 * and weapons belong to callers.
 *
 * A hold ends the moment it can no longer change the health bar. Below
 * eighteen hunger vanilla regenerates nothing, so a bot with nothing to eat is
 * waiting for nothing; on 2026-09-09 seven such holds cost a bot at two health
 * ninety seconds apiece, ten minutes in which the model heard nothing and
 * could do nothing. Saying so at once hands the body back sealed in, which is
 * the only thing the hold had left to offer.
 */
export async function recoverUnderCover(bot: Bot, options: CoveredRecoveryOptions): Promise<CoveredRecovery> {
  let ate: string | null = null;
  const hazardNow = (): Hazard | null => {
    if (!options.isProtected()) return "open";
    if (isInFire(bot)) return "burning";
    if (isInLava(bot)) return "molten";
    return incomingShieldProjectiles(bot).length > 0 ? "projectile" : null;
  };
  /**
   * The hazard that still holds once a fire in the shell is dug out, or null when the position is usable. A dead bot
   * is null too: its exits below decide. A fire the shell's owner may not dig stays and is the hazard.
   */
  const unlessCleared = async (): Promise<Hazard | null> => {
    if (bot.health <= 0) return null;
    const hazard = hazardNow();
    if (hazard !== "burning" || !options.extinguish) return hazard;
    for (const cell of fireContactCells(bot)) {
      if ((await options.extinguish(cell)) === "blocked") break;
    }
    return bot.health > 0 ? hazardNow() : null;
  };
  options.signal.throwIfAborted();
  if (await unlessCleared()) return { kind: "exposed", ate };
  const survival = options.survival;
  const policy = options.policy;
  const scope = recoveryScope(bot, policy, options.recoverTo);
  const answered = survival.answered.find(scope.capability, scope.scope);
  if (answered) return { kind: "held", stop: "answered", ate, reason: answered.failure.why };
  if (policy().combat.recover === "never" && !options.holdWhile)
    return { kind: "held", stop: "prohibited", ate, reason: "Recovery is prohibited." };
  using budget = survival.budgets.attempt({
    name: "covered_recovery",
    scope: scope.scope,
    unit: "milliseconds",
    limit: options.maximumMs,
    measure: monotonicNow,
    exhaustion: "Retain observed enclosure and return exhausted recovery with current health and hunger.",
  });
  const held = (stop: "exhausted" | "unavailable" | "eating_failed", reason: string): CoveredRecovery => {
    options.signal.throwIfAborted();
    if (bot.health <= 0) return { kind: "held", stop: "death", ate, reason: "The bot died during recovery." };
    survival.answered.remember(scope, { kind: stop, why: reason });
    return { kind: "held", stop, ate, reason };
  };
  while ((bot.health < options.recoverTo || (policy().combat.recover !== "never" && bot.food < REGENERATION_HUNGER) || options.holdWhile?.()) && bot.health > 0 && !budget.exhausted) {
    options.signal.throwIfAborted();
    await options.defendIntruder();
    if (await unlessCleared()) return { kind: "exposed", ate };
    if (bot.health <= 0) break;
    // Defensive cover can finish without healing. Keep the shell closed
    // through the attack, then hand back only if the caller's health floor is
    // met; never eat or wait for regeneration against an explicit prohibition.
    if (policy().combat.recover === "never") {
      if (options.holdWhile?.()) { await options.wait(1); continue; }
      return bot.health >= options.recoverTo
        ? { kind: "recovered", ate }
        : { kind: "held", stop: "prohibited", ate, reason: `Defence ended at health ${bot.health}; required ${options.recoverTo}, but recovery is prohibited.` };
    }
    if (bot.food < REGENERATION_HUNGER && !hasRegeneration(bot)) {
      const meal = await eatInHold(bot, options, ate, hazardNow, unlessCleared, held);
      ate = meal.ate;
      if (meal.end === "leave") break;
      if (meal.end) return meal.end;
      // A bite can end with the bot dead (a fire dug out after it): its exits decide, never a wait.
      if (bot.health <= 0) break;
    }
    await options.wait(1);
  }
  if (await unlessCleared()) return { kind: "exposed", ate };
  return bot.health >= options.recoverTo && !options.holdWhile?.()
    ? { kind: "recovered", ate }
    : held(
        "exhausted",
        `the ${Math.round(options.maximumMs / 1000)}-second hold ran out at health ${bot.health}; required ${options.recoverTo}${options.holdWhile?.() ? "; the threat still prevents leaving cover" : ""}`,
      );
}
