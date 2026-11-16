import { eatCheckpointSchema } from "../checkpoint-schemas.js";
import type { Bot } from "mineflayer";
import { recordCombatResourceReceipt } from "../../runtime/combat-resource-receipts.js";
import { monotonicNow, raceSignal } from "../../utils/index.js";
import { carriedCount, settledNow, type SettledInventoryCount } from "../../world/index.js";
import { hasItemFamily } from "../../world/item-families.js";
import { SERVER_ANSWER_TICKS, waitForServerAnswer, waitForWorldAge } from "../../world/world-age.js";
import { defineAction, type ActionContext, type RequestExecution } from "../action.js";
import type { ObserveRequest } from "../../session/request.js";
import { unconfirmedCount } from "../markdown.js";
import { biteTicks, diedSince, heldBiteLanded, startBite, watchBiteStatus, type Bite, type BiteMark, type BiteStatus } from "./bite.js";
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

/**
 * Longest one eat takes on the monotonic clock, from its start (the equip included). Below the hunger reflex's 20 s
 * ceiling (`hunger.ts:19`), which starts at the claim: 5 s are left for the yield before `act`. Mineflayer's own 2.5 s
 * bound on `consume` (`inventory.js:15`) decides nothing: the bite is waited for in server ticks (spec
 * 2026-11-08-p4-eat-lag D1), and this wall time only covers a server whose clock stands still.
 */
const EAT_WALL_MS = 15_000;

export interface EatFoodDependencies {
  readonly equip: Bot["equip"];
  readonly consume: Bot["consume"];
  /** Longest the whole eat takes on the monotonic clock; default `EAT_WALL_MS`. */
  readonly wallMs?: number;
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
 * the bite already landed (the slot it was made from one fewer) and succeeds without a second bite. Only a bite of ours
 * can have landed: one carried fewer with no consume of ours is the hunger reflex's own meal of the same food (review
 * 2026-10-19), so the request eats again. A bite whose use went out may still be eaten by a server that read our release
 * late, so the attempt after it first waits that server's answer time from the use.
 */
export function beginEatFood(
  bot: Bot,
  request: EatFoodRequest,
  observe: ObserveRequest,
  dependencies: EatFoodDependencies = defaultDependencies(bot),
): RequestExecution<EatFoodResult> {
  const before = eatingBaseline(bot, request);
  observeEating(observe, bot, request, before);
  let lastBite: BiteMark | undefined;
  return async (context) => {
    context.signal?.throwIfAborted();
    if (lastBite && (await earlierBiteLanded(bot, request, lastBite, context.signal))) {
      return { status: "succeeded", eating: evidence(bot, request, before, true) };
    }
    return eatAgainstBaseline(bot, request, before, context, dependencies, (mark) => { lastBite = mark; });
  };
}

/** Whether the bite an earlier attempt made shows in its slot, after the server's answer time when its use went out. */
async function earlierBiteLanded(bot: Bot, request: EatFoodRequest, mark: BiteMark, signal: AbortSignal | undefined): Promise<boolean> {
  const landed = () => slotShowsBite(bot, request, mark);
  if (mark.sent) await waitForServerAnswer(bot, mark.sentAtAge, { until: landed, wallMs: EAT_WALL_MS, ...(signal && { signal }) });
  return landed();
}

/** The slot the bite was made from shows it, and she has not died since: a death empties the slots and the respawn heals her. */
function slotShowsBite(bot: Bot, request: EatFoodRequest, mark: BiteMark): boolean {
  return !diedSince(bot, mark) && heldBiteLanded(bot, mark.slot, request.foodName, mark.countAtStart);
}

/** Milliseconds of the eat's wall bound still unspent. */
function wallLeft(startedAt: number, wallMs: number): number {
  return Math.max(0, wallMs - (monotonicNow() - startedAt));
}

/**
 * After the bite: wait for the slot it was made from to show it (for the evidence), within one server answer time and what
 * is left of the eat's wall bound. `confirmed` is that slot's own change, so a same-food pickup elsewhere does not read as no meal.
 */
async function settleBiteSlot(
  bot: Bot,
  request: EatFoodRequest,
  mark: BiteMark,
  limits: { readonly startedAt: number; readonly wallMs: number; readonly signal: AbortSignal | undefined },
): Promise<SettledInventoryCount> {
  const shown = () => slotShowsBite(bot, request, mark);
  await waitForServerAnswer(bot, undefined, {
    until: () => shown() || diedSince(bot, mark),
    wallMs: wallLeft(limits.startedAt, limits.wallMs),
    ...(limits.signal && { signal: limits.signal }),
  });
  return { count: carriedCount(bot, request.foodName), confirmed: shown() };
}

/** The server's side of a bite the client is done with: landed, ignored, refused or killed. */
interface BiteWatch {
  readonly bite: Bite;
  /** Landed: the server ended the bite (status 9) or the held slot shows it, and she has not died since. */
  landed(): boolean;
  died(): boolean;
}

function watchOf(bot: Bot, request: EatFoodRequest, bite: Bite, status: BiteStatus): BiteWatch {
  const died = () => diedSince(bot, bite.mark);
  return { bite, died, landed: () => !died() && (status.finished() || slotShowsBite(bot, request, bite.mark)) };
}

/** What `eatAgainstBaseline` returns once the bite's wait is over, from how the wait and the bite ended. */
async function judgeBite(
  bot: Bot,
  request: EatFoodRequest,
  before: EatingBefore,
  watch: BiteWatch,
  ended: Awaited<ReturnType<typeof waitForWorldAge>>,
  waited: { readonly ageAtStart: number | undefined; readonly startedAt: number; readonly wallMs: number; readonly signal: AbortSignal | undefined },
): Promise<EatFoodResult> {
  const { bite } = watch;
  const consumeEnd = bite.end();
  if (!bite.mark.sent && consumeEnd.kind === "rejected" && !watch.landed()) {
    return { status: "failed", error: eatFoodOutcomes.rejected(consumeEnd.cause), eating: evidence(bot, request, before, false) };
  }
  if (watch.died()) {
    if (bot.usingHeldItem) bot.deactivateItem();
    return { status: "failed", error: eatFoodOutcomes.died(request.foodName), eating: evidence(bot, request, before, false) };
  }
  if (ended === "until") {
    // Landed: the slot packet follows the status, so this is the evidence. Over without a landing (the promise resolved on a
    // held-item update, or rejected): the server gets one answer time to show the bite.
    const after = await settleBiteSlot(bot, request, bite.mark, waited);
    waited.signal?.throwIfAborted();
    if (watch.died()) return { status: "failed", error: eatFoodOutcomes.died(request.foodName), eating: evidence(bot, request, before, false) };
    if (watch.landed()) {
      recordCombatResourceReceipt(bot, { kind: "food_eaten" });
      return { status: "succeeded", eating: evidence(bot, request, before, true, after) };
    }
  }
  if (bot.usingHeldItem) bot.deactivateItem();
  if (ended === "until" && consumeEnd.kind === "rejected") {
    return { status: "failed", error: eatFoodOutcomes.rejected(consumeEnd.cause), eating: evidence(bot, request, before, false) };
  }
  const serverTicks = waited.ageAtStart === undefined || bot.time?.age == null ? 0 : bot.time.age - waited.ageAtStart;
  const unconfirmed = { count: carriedCount(bot, request.foodName), confirmed: false };
  return {
    status: "failed",
    error: eatFoodOutcomes.notObserved(request.foodName, serverTicks),
    eating: evidence(bot, request, before, false, unconfirmed),
  };
}

async function eatAgainstBaseline(
  bot: Bot,
  request: EatFoodRequest,
  before: EatingBefore,
  context: ActionContext,
  dependencies: EatFoodDependencies,
  onBiteMade: (mark: BiteMark) => void = () => {},
): Promise<EatFoodResult> {
  const startedAt = monotonicNow();
  const wallMs = dependencies.wallMs ?? EAT_WALL_MS;
  if (!hasItemFamily(bot, request.foodName, "food")) {
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
  const stopConsumption = () => {
    if (consuming && bot.usingHeldItem) bot.deactivateItem();
  };
  context.signal?.addEventListener("abort", stopConsumption, { once: true });
  // Mineflayer may resolve consume before the bite actually finishes. Keep
  // cancellation attached through the wait for the server's end of the bite as well.
  resources.defer(() => context.signal?.removeEventListener("abort", stopConsumption));
  try {
    await raceSignal(dependencies.equip(item, "hand"), context.signal);
    context.signal?.throwIfAborted();
  } catch (cause) {
    context.signal?.throwIfAborted();
    if (bot.usingHeldItem) bot.deactivateItem();
    return { status: "failed", error: eatFoodOutcomes.rejected(cause), eating: evidence(bot, request, before, false) };
  }
  consuming = true;
  const status = watchBiteStatus(bot, resources);
  // The stack in hand: after a real equip, the hotbar slot Mineflayer moved it to; a stubbed equip leaves it where it was.
  const held = bot.heldItem?.name === item.name ? bot.heldItem : item;
  const bite = startBite(bot, dependencies.consume, held);
  onBiteMade(bite.mark);
  // Mineflayer's deactivateItem releases the hand but leaves consume's promise pending until its 2.5 s timeout: the bite is
  // never awaited, only recorded, so a release or a late rejection holds nothing. One microtask lets a refusal that
  // `consume` made before its first await ("Food is full") be recorded.
  await Promise.resolve();
  const watch = watchOf(bot, request, bite, status);
  const waited = { ageAtStart: bot.time?.age ?? undefined, startedAt, wallMs, signal: context.signal };
  const ended = await waitForWorldAge(bot, biteTicks(held) + SERVER_ANSWER_TICKS, {
    wallMs: wallLeft(startedAt, wallMs),
    ...(context.signal && { signal: context.signal }),
    until: () => watch.landed() || watch.died() || (bite.end().kind !== "pending" && !bot.usingHeldItem),
  });
  // Awaited: a bare `return promise` would dispose the status listener and the abort listener before the judge's settle ends.
  return await judgeBite(bot, request, before, watch, ended, waited);
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
