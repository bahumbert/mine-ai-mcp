import { craftCheckpointSchema } from "../checkpoint-schemas.js";
import type { Bot } from "mineflayer";
import { observeInventoryProgress } from "../progress.js";
import type { NavigationRuntime } from "../../navigation/index.js";
import {
  planCraftingFromInventory,
  type CraftPlanOptions,
  type CraftPreparation,
  type CraftTarget,
} from "../../utils/craft-plan.js";
import type { Position3 } from "../../utils/index.js";
import type { ObserveRequest } from "../../session/request.js";
import { executeCraftPlan, type CraftExecution } from "../../world/crafting.js";
import { recipesFor } from "../../world/smelting.js";
import { carriedCount, settledNow, settleInventoryMinimum, type SettledInventoryCount } from "../../world/index.js";
import type { WorldBlock } from "../../world/placement.js";
import { unknownItemAnswer } from "../../world/mob-drops.js";
import { defineAction, type ActionContext } from "../action.js";
import { markdownCodeBlock, unconfirmedCount } from "../markdown.js";
import {
  formatWorkstation,
  useTemporaryWorkstation,
  workstationOperations,
  type WorkstationHold,
  type WorkstationOperations,
} from "../temporary-workstation.js";
import {
  craftItemAnnotations,
  craftItemOutcomes,
  parseCraftItemRequest,
  CRAFT_ITEM,
  CRAFT_ITEM_DESCRIPTION,
  craftItemInputSchema,
  craftItemResultSchema,
  type CraftEvidence,
  type CraftItemRequest,
  type CraftItemResult,
} from "./contract.js";
import { prepareCraftingStation, reachCraftingTable, type TableHold } from "./crafting-station.js";

type FailedCraftPreparation = Exclude<CraftPreparation, { readonly kind: "ready" }>;

interface ResolvedCraftItem extends CraftTarget {
  readonly inventoryBefore: number;
}

interface CraftItemObservation {
  readonly item: string;
  readonly requested: number;
  readonly inventoryBefore: number;
  /** Omitted only when no preparation or crafting changed inventory. */
  readonly after?: SettledInventoryCount;
  readonly usedForWorkstation?: number;
}

interface CraftEvidenceInput {
  readonly items: readonly CraftItemObservation[];
  readonly completedSteps?: number;
  readonly preparation?: CraftPreparation;
  readonly craftingTablePlaced?: Position3;
}

function craftEvidence({
  items,
  completedSteps = 0,
  preparation,
  craftingTablePlaced,
}: CraftEvidenceInput): CraftEvidence {
  return {
    ...(craftingTablePlaced ? { craftingTablePlaced } : {}),
    items: items.map(
      ({
        item,
        requested,
        inventoryBefore,
        after = { count: inventoryBefore, confirmed: true },
        usedForWorkstation = 0,
      }) => ({
        item,
        requested,
        gained: Math.max(0, after.count - inventoryBefore + usedForWorkstation),
        usedForWorkstation,
        inventoryBefore,
        inventoryAfter: after.count,
        confirmed: after.confirmed,
      }),
    ),
    completedSteps,
    plan: preparation?.plan,
  };
}

function preparationFailureResult(
  preparation: FailedCraftPreparation,
  evidence: CraftEvidenceInput,
  version: string,
): Extract<CraftItemResult, { status: "failed" }> {
  let error: string;

  switch (preparation.kind) {
    case "uncraftable": {
      // What a furnace makes is said, from the game's recipes (live 2026-10-10: "craft cooked_beef" sent 18 times).
      const smelted = preparation.items.flatMap((item) => {
        const from = [...new Set(recipesFor(item, version).flatMap((recipe) => recipe.inputs))];
        return from.length === 0 ? [] : [{ item, from: from.slice(0, 3) }];
      });
      error = craftItemOutcomes.uncraftable(preparation.items, smelted);
      break;
    }
    case "missing_materials":
      error = craftItemOutcomes.missingMaterials(preparation.plan.missingMaterials);
      break;
    case "planner_failed":
      error = craftItemOutcomes.plannerFailed(preparation.items);
      break;
  }

  return {
    status: "failed",
    error,
    craft: craftEvidence({ ...evidence, preparation }),
  };
}

/** What one craft request has done so far, kept across the attempts a reflex splits it into. */
interface CraftProgress {
  /** Carried counts when the request began, per target: every attempt measures its gains against these. */
  readonly baselines: Map<string, number>;
  /** The table the request set down (not a temporary one) and the carried tables it used. */
  readonly table: TableHold;
}

function newCraftProgress(): CraftProgress {
  return { baselines: new Map(), table: { placedAt: null, usedCarried: 0 } };
}

interface CraftTargets {
  readonly items: ResolvedCraftItem[];
  readonly requestedItems: CraftItemObservation[];
  readonly unknownItems: string[];
}

/** The registry item of each requested name, with the carried count the request began from. */
function resolveCraftTargets(bot: Bot, request: CraftItemRequest, progress: CraftProgress): CraftTargets {
  const items: ResolvedCraftItem[] = [];
  const requestedItems: CraftItemObservation[] = [];
  const unknownItems: string[] = [];
  for (const requested of request.items) {
    const target = bot.registry.itemsByName[requested.itemName];
    if (!target) {
      unknownItems.push(unknownItemAnswer(requested.itemName, Object.keys(bot.registry.itemsByName), bot.registry.entitiesByName, bot.version));
      requestedItems.push({ item: requested.itemName, requested: requested.count, inventoryBefore: 0 });
      continue;
    }
    const inventoryBefore = progress.baselines.get(target.name) ?? carriedCount(bot, target.name);
    progress.baselines.set(target.name, inventoryBefore);
    items.push({ id: target.id, name: target.name, count: requested.count, inventoryBefore });
    requestedItems.push({ item: target.name, requested: requested.count, inventoryBefore, after: settledNow(bot, target.name) });
  }
  return { items, requestedItems, unknownItems };
}

/** The targets still short of the request, each with the count left: what earlier attempts crafted is carried already. */
function stillToCraft(bot: Bot, items: readonly ResolvedCraftItem[], progress: CraftProgress): CraftTarget[] {
  return items.flatMap(({ id, name, count, inventoryBefore }) => {
    const usedForTable = name === "crafting_table" ? progress.table.usedCarried : 0;
    const left = count - Math.max(0, carriedCount(bot, name) - inventoryBefore + usedForTable);
    return left > 0 ? [{ id, name, count: left }] : [];
  });
}

/** The request's inventory gains against its baselines, once the server has corrected optimistic clicks. */
async function settleCraftedGains(
  bot: Bot,
  items: readonly ResolvedCraftItem[],
  progress: CraftProgress,
  signal?: AbortSignal,
): Promise<CraftItemObservation[]> {
  return Promise.all(
    items.map(async ({ name, count, inventoryBefore }) => {
      const usedForWorkstation = name === "crafting_table" ? progress.table.usedCarried : 0;
      return {
        item: name,
        requested: count,
        inventoryBefore,
        usedForWorkstation,
        after: await settleInventoryMinimum(bot, name, inventoryBefore + count - usedForWorkstation, { signal }),
      };
    }),
  );
}

/** The request's result once its recipes have run (or none were left to run): shortfalls make it partial. */
function craftOutcome(
  bot: Bot,
  settled: readonly CraftItemObservation[],
  execution: CraftExecution | null,
  preparation: CraftPreparation | undefined,
  progress: CraftProgress,
): CraftItemResult {
  const observed = craftEvidence({
    items: settled,
    completedSteps: execution?.completedSteps,
    preparation,
    craftingTablePlaced: progress.table.placedAt ?? undefined,
  });
  if (execution?.kind === "failed") {
    return {
      status: execution.completedSteps > 0 ? "partial" : "failed",
      error: craftItemOutcomes.executionFailed(execution.cause, carriedCount(bot, "unknown")),
      craft: observed,
    };
  }
  const shortfalls = observed.items.filter(({ gained, requested }) => gained < requested);
  if (shortfalls.length > 0) {
    return { status: "partial", error: craftItemOutcomes.resultNotObserved(shortfalls), craft: observed };
  }
  return { status: "succeeded", craft: observed };
}

/** A table to craft on: the temporary one, the one this request put down, one in reach, or a carried one placed now. */
async function stationForBatch(
  bot: Bot,
  navigation: NavigationRuntime,
  remaining: readonly CraftTarget[],
  requiresTable: boolean,
  progress: CraftProgress,
  context: ActionContext,
  providedTable: WorldBlock | undefined,
  planOptions: CraftPlanOptions,
) {
  const station = providedTable
    ? { kind: "ready" as const, craftingTable: providedTable }
    : await prepareCraftingStation(bot, remaining, requiresTable, {
        hold: progress.table,
        signal: context.signal,
        planOptions,
      });
  // A reflex may have moved the bot away from a table that is still ours (also the temporary one).
  if (station.kind === "ready" && station.craftingTable && (providedTable || progress.table.placedAt)) {
    await reachCraftingTable(bot, navigation, station.craftingTable, context.signal);
  }
  return station;
}

/** Plan what is left of the request against what is carried now, craft it, and settle every requested gain. */
async function craftBatch(
  bot: Bot,
  navigation: NavigationRuntime,
  request: CraftItemRequest,
  context: ActionContext,
  progress: CraftProgress,
  providedTable?: WorldBlock,
  seen?: (item: string) => number,
): Promise<CraftItemResult> {
  context.signal?.throwIfAborted();
  const { items, requestedItems, unknownItems } = resolveCraftTargets(bot, request, progress);
  if (unknownItems.length > 0) {
    return { status: "failed", error: craftItemOutcomes.unknownItems(unknownItems), craft: craftEvidence({ items: requestedItems }) };
  }
  const remaining = stillToCraft(bot, items, progress);
  if (remaining.length === 0) {
    return craftOutcome(bot, await settleCraftedGains(bot, items, progress, context.signal), null, undefined, progress);
  }

  const planOptions = seen ? { seen } : {};
  const initialPlan = planCraftingFromInventory(bot, remaining, planOptions);
  if (initialPlan.kind !== "ready") return preparationFailureResult(initialPlan, { items: requestedItems }, bot.version);
  const station = await stationForBatch(bot, navigation, remaining, initialPlan.plan.requiresCraftingTable, progress, context, providedTable, planOptions);
  if (station.kind === "plan_failed") {
    const failure = preparationFailureResult(station.preparation, { items: requestedItems }, bot.version);
    return {
      ...failure,
      error: `No crafting table is in reach or carried. Preparing one for this batch: ${failure.error}`,
    };
  }
  const unsettled = (usedForTable: boolean) =>
    items.map(({ name, count, inventoryBefore }) => ({
      item: name,
      requested: count,
      inventoryBefore,
      after: settledNow(bot, name),
      usedForWorkstation: usedForTable && name === "crafting_table" ? progress.table.usedCarried : 0,
    }));
  if (station.kind === "failed") {
    return {
      status: "failed",
      error: station.error,
      craft: craftEvidence({ items: unsettled(false), preparation: initialPlan }),
    };
  }
  // Workstation preparation can consume materials; plan the batch against what remains.
  const preparation = planCraftingFromInventory(bot, stillToCraft(bot, items, progress), planOptions);
  if (preparation.kind !== "ready") {
    return preparationFailureResult(preparation, {
      craftingTablePlaced: progress.table.placedAt ?? undefined,
      items: unsettled(true),
    }, bot.version);
  }
  const execution = await executeCraftPlan(bot, preparation.applications, station.craftingTable, context.signal);
  const settled = await settleCraftedGains(bot, items, progress, context.signal);
  return craftOutcome(bot, settled, execution, preparation, progress);
}

/**
 * Start a craft request: take the baselines once and return the executor the runner calls for each attempt. A reflex
 * that takes the body mid-craft aborts an attempt; the next crafts only what is left, on the same table.
 */
export function beginCraftItem(
  bot: Bot,
  navigation: NavigationRuntime,
  request: CraftItemRequest,
  observe: ObserveRequest,
  seen?: (item: string) => number,
  operations: WorkstationOperations = workstationOperations(bot, navigation),
): (context: ActionContext) => Promise<CraftItemResult> {
  observeInventoryProgress({ observeProgress: observe }, bot, request.items, () => "crafting", "All requested net item gains are still carried after crafting and workstation cleanup.");
  const progress = newCraftProgress();
  if (!request.temporaryWorkstation) {
    return (context) => craftBatch(bot, navigation, request, context, progress, undefined, seen);
  }
  const tablesBefore = carriedCount(bot, "crafting_table");
  const hold: WorkstationHold = { placedAt: null };
  return async (context) => {
    const result = await useTemporaryWorkstation(
      bot,
      "crafting_table",
      context,
      operations,
      (table) => craftBatch(bot, navigation, request, context, progress, table, seen),
      (error) => ({
        status: "failed",
        error,
        craft: craftEvidence({
          items: request.items.map(({ itemName, count }) => ({
            item: itemName,
            requested: count,
            inventoryBefore: progress.baselines.get(itemName) ?? carriedCount(bot, itemName),
          })),
        }),
      }),
      hold,
    );
    // The batch's baseline was taken after placement. Restore the caller's baseline
    // and final count without counting the recovered table as newly crafted output.
    if (result.workstation) {
      for (const item of result.craft.items) {
        if (item.item !== "crafting_table") continue;
        item.inventoryBefore = tablesBefore;
        item.inventoryAfter = carriedCount(bot, item.item);
        item.usedForWorkstation = result.workstation.recovered ? 0 : 1;
      }
      result.craft.craftingTablePlaced = result.workstation.position;
    }
    return result;
  };
}

/** Plan the complete batch before consuming anything, then settle every requested inventory gain, in one attempt. */
export async function craftItem(
  bot: Bot,
  navigation: NavigationRuntime,
  request: CraftItemRequest,
  context: ActionContext,
  seen?: (item: string) => number,
): Promise<CraftItemResult> {
  return beginCraftItem(bot, navigation, request, context.observeProgress ?? (() => {}), seen)(context);
}


export function formatCraftItemResult(result: CraftItemResult): string {
  const { craft } = result;
  const lines = [
    ...formatWorkstation(result.workstation),
    result.status === "succeeded"
      ? `Crafted all **${craft.items.length} requested item types** from the bot's inventory.`
      : `**Observed stop:** ${result.error}`,
    ...craft.items.map(
      ({ item, requested, gained, inventoryBefore, inventoryAfter, confirmed, usedForWorkstation }) =>
        `- ${item}: gained ${gained}/${requested}; inventory ${inventoryBefore} → ${inventoryAfter}${unconfirmedCount(confirmed)}${usedForWorkstation ? `; used ${usedForWorkstation} for the workstation` : ""}`,
    ),
    `- Recipe steps completed: ${craft.completedSteps}${craft.plan ? `/${craft.plan.steps.length}` : ""}`,
    ...(craft.craftingTablePlaced
      ? [
          `- Placed a carried crafting table at \`${craft.craftingTablePlaced.x}, ${craft.craftingTablePlaced.y}, ${craft.craftingTablePlaced.z}\` for this batch`,
        ]
      : []),
  ];
  if (craft.plan) {
    lines.push(`- Crafting table required: ${craft.plan.requiresCraftingTable}`);
    lines.push(
      `- Required leaf materials: ${craft.plan.requiredMaterials.length > 0 ? craft.plan.requiredMaterials.map(({ item, count }) => `${item} ×${count}`).join(", ") : "none"}`,
    );
    lines.push(
      `- Carried leaf materials reserved: ${craft.plan.carriedMaterials.length > 0 ? craft.plan.carriedMaterials.map(({ item, count }) => `${item} ×${count}`).join(", ") : "none"}`,
    );
    if (craft.plan.missingMaterials.length > 0) {
      lines.push(
        `- Missing leaves: ${craft.plan.missingMaterials.map(({ item, count }) => `${item} ×${count}`).join(", ")}`,
      );
    }
    lines.push("", "Selected recipe paths:", "", markdownCodeBlock(craft.plan.tree));
  }
  return lines.join("\n");
}

export function createCraftItemAction(bot: Bot, navigation: NavigationRuntime, seen?: (item: string) => number) {
  return defineAction({
    checkpointSchema: craftCheckpointSchema,
    name: CRAFT_ITEM,
    description: CRAFT_ITEM_DESCRIPTION,
    inputSchema: craftItemInputSchema,
    resultSchema: craftItemResultSchema,
    formatResult: formatCraftItemResult,
    execution: { kind: "resumable_task" },
    annotations: craftItemAnnotations,
    parse: parseCraftItemRequest,
    begin: (request, _lifetime, observe) => beginCraftItem(bot, navigation, request, observe, seen),
  });
}
