import { eatCheckpointSchema } from "../checkpoint-schemas.js";
import type { Bot } from "mineflayer";
import { recordCombatResourceReceipt } from "../../runtime/combat-resource-receipts.js";
import { carriedCount, settledNow, settleInventoryCount, type SettledInventoryCount } from "../../world/index.js";
import { defineAction, type ActionContext, type RequestExecution } from "../action.js";
import type { ObserveRequest } from "../../session/request.js";
import { unconfirmedCount } from "../markdown.js";
import {
  eatFoodAnnotations,
  eatFoodOutcomes,
  parseEatFoodRequest,
  EAT_FOOD,
  EAT_FOOD_DESCRIPTION,
  eatFoodInputSchema,
  eatFoodResultSchema,
  type EatFoodEvidence,
  type EatFoodRequest,
  type EatFoodResult,
} from "./contract.js";

// Mineflayer can resolve consume on a held-item update before eating finishes.
// Its own 2.5-second consume allowance covers the normal 1.6-second bite plus
// server latency; use that allowance to observe the actual inventory decrease.
const CONSUMPTION_SETTLE_MS = 2_500;

export interface EatFoodDependencies {
  readonly equip: Bot["equip"];
  readonly consume: Bot["consume"];
  /** How long the server gets to show the eaten item leaving the inventory. */
  readonly settleMs?: number;
}

interface EatingBefore {
  readonly inventory: number;
  readonly hunger: number;
  readonly saturation: number;
}

function evidence(
  bot: Bot,
  request: EatFoodRequest,
  before: EatingBefore,
  consumed: boolean,
  /** The settled count, on the one path that ate. */
  after: SettledInventoryCount = settledNow(bot, request.foodName),
): EatFoodEvidence {
  return {
    food: request.foodName,
    inventoryBefore: before.inventory,
    inventoryAfter: after.count,
    confirmed: after.confirmed,
    hungerBefore: before.hunger,
    hungerAfter: bot.food,
    saturationBefore: before.saturation,
    saturationAfter: bot.foodSaturation,
    consumed,
  };
}

function eatingBaseline(bot: Bot, request: EatFoodRequest): EatingBefore {
  return { inventory: carriedCount(bot, request.foodName), hunger: bot.food, saturation: bot.foodSaturation };
}

function observeEating(observe: ObserveRequest | undefined, bot: Bot, request: EatFoodRequest, before: EatingBefore): void {
  observe?.(() => ({ baseline: { ...before },
    checkpoint: { phase: "eating", item: request.foodName, inventory: carriedCount(bot, request.foodName), hunger: bot.food, saturation: bot.foodSaturation },
    completion: { kind: "event", observed: false, owes: "Consumption and its inventory/hunger evidence must be confirmed by the eating executor." },
  }));
}

function defaultDependencies(bot: Bot): EatFoodDependencies {
  return { equip: bot.equip.bind(bot), consume: bot.consume.bind(bot) };
}

/** Equip and consume exactly one named carried food item. */
export async function eatFood(
  bot: Bot,
  request: EatFoodRequest,
  context: ActionContext,
  dependencies: EatFoodDependencies = defaultDependencies(bot),
): Promise<EatFoodResult> {
  context.signal?.throwIfAborted();
  const before = eatingBaseline(bot, request);
  observeEating(context.observeProgress, bot, request, before);
  return eatAgainstBaseline(bot, request, before, context, dependencies);
}

/**
 * One request's executor: the baseline is taken once, so an attempt a reflex interrupted is followed by one that sees
 * the bite already landed (one carried fewer) and succeeds without a second bite.
 */
export function beginEatFood(
  bot: Bot,
  request: EatFoodRequest,
  observe: ObserveRequest,
  dependencies: EatFoodDependencies = defaultDependencies(bot),
): RequestExecution<EatFoodResult> {
  const before = eatingBaseline(bot, request);
  observeEating(observe, bot, request, before);
  return async (context) => {
    context.signal?.throwIfAborted();
    if (carriedCount(bot, request.foodName) < before.inventory) {
      return { status: "succeeded", eating: evidence(bot, request, before, true) };
    }
    return eatAgainstBaseline(bot, request, before, context, dependencies);
  };
}

async function eatAgainstBaseline(
  bot: Bot,
  request: EatFoodRequest,
  before: EatingBefore,
  context: ActionContext,
  dependencies: EatFoodDependencies,
): Promise<EatFoodResult> {
  if (!bot.registry.foodsByName[request.foodName]) {
    return {
      status: "failed",
      error: eatFoodOutcomes.unknownFood(request.foodName),
      eating: evidence(bot, request, before, false),
    };
  }

  const item = bot.inventory.items().find((candidate) => candidate.name === request.foodName);
  if (!item) {
    return {
      status: "failed",
      error: eatFoodOutcomes.notCarried(request.foodName),
      eating: evidence(bot, request, before, false),
    };
  }

  using resources = new DisposableStack();
  let consuming = false;
  let cancelWait: ((reason: unknown) => void) | null = null;
  const stopConsumption = () => {
    if (consuming && bot.usingHeldItem) bot.deactivateItem();
    cancelWait?.(context.signal?.reason);
  };
  context.signal?.addEventListener("abort", stopConsumption, { once: true });
  // Mineflayer may resolve consume before the bite actually finishes. Keep
  // cancellation attached through inventory confirmation as well.
  resources.defer(() => context.signal?.removeEventListener("abort", stopConsumption));
  try {
    await dependencies.equip(item, "hand");
    context.signal?.throwIfAborted();
    consuming = true;
    // Mineflayer's deactivateItem releases the hand, but leaves consume's
    // completion promise pending until its 2.5-second timeout. Once released,
    // defence must not wait on that bookkeeping promise. Its late rejection
    // remains handled by the race; it performs no further body effects.
    const cancelled = new Promise<never>((_resolve, reject) => { cancelWait = reject; });
    await Promise.race([dependencies.consume(), cancelled]);
    cancelWait = null;
    context.signal?.throwIfAborted();
  } catch (cause) {
    context.signal?.throwIfAborted();
    if (bot.usingHeldItem) bot.deactivateItem();
    return {
      status: "failed",
      error: eatFoodOutcomes.rejected(cause),
      eating: evidence(bot, request, before, false),
    };
  }

  const after = await settleInventoryCount(bot, request.foodName, before.inventory - 1, {
    timeoutMs: dependencies.settleMs ?? CONSUMPTION_SETTLE_MS,
    signal: context.signal,
  });
  context.signal?.throwIfAborted();
  if (!after.confirmed) {
    return {
      status: "failed",
      error: eatFoodOutcomes.notObserved(request.foodName),
      eating: evidence(bot, request, before, false, after),
    };
  }
  recordCombatResourceReceipt(bot, { kind: "food_eaten" });
  return {
    status: "succeeded",
    eating: evidence(bot, request, before, true, after),
  };
}

export function formatEatFoodResult(result: EatFoodResult): string {
  const { eating } = result;
  const lines = [
    eating.consumed ? `Consumed one **${eating.food}**.` : `No consumption of **${eating.food}** was observed.`,
    `- Inventory: ${eating.inventoryBefore} → ${eating.inventoryAfter}${unconfirmedCount(eating.confirmed)}`,
    `- Hunger: ${eating.hungerBefore} → ${eating.hungerAfter}`,
    `- Saturation: ${eating.saturationBefore.toFixed(2)} → ${eating.saturationAfter.toFixed(2)}`,
  ];
  if (result.status !== "succeeded") lines.push("", `**Observed stop:** ${result.error}`);
  return lines.join("\n");
}

export function createEatFoodAction(bot: Bot) {
  return defineAction({
    checkpointSchema: eatCheckpointSchema,
    name: EAT_FOOD,
    description: EAT_FOOD_DESCRIPTION,
    inputSchema: eatFoodInputSchema,
    resultSchema: eatFoodResultSchema,
    formatResult: formatEatFoodResult,
    execution: { kind: "resumable_task" },
    annotations: eatFoodAnnotations,
    parse: parseEatFoodRequest,
    begin: (request, _lifetime, observe) => beginEatFood(bot, request, observe),
  });
}
