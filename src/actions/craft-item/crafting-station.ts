import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { createMovements, nearGoal, type NavigationRuntime } from "../../navigation/index.js";
import { planCraftingFromInventory, type CraftPlanOptions, type CraftPreparation, type CraftTarget } from "../../utils/craft-plan.js";
import type { Position3 } from "../../utils/index.js";
import { carriedCount, placeCarriedBlockNearby, settleInventoryCount, type WorldBlock } from "../../world/index.js";
import { executeCraftPlan } from "../../world/crafting.js";
import { craftItemOutcomes } from "./contract.js";

type CraftingStation =
  | { readonly kind: "ready"; readonly craftingTable: WorldBlock | null }
  | { readonly kind: "failed"; readonly error: string }
  | { readonly kind: "plan_failed"; readonly preparation: Exclude<CraftPreparation, { kind: "ready" }> };

/** The table one craft request set down, kept across attempts so a resume goes back to it instead of making another. */
export interface TableHold {
  placedAt: Position3 | null;
  /** Carried tables the request put down (counted as gained when the request asks for a `crafting_table`). */
  usedCarried: number;
}

interface StationOptions {
  readonly hold: TableHold;
  readonly signal?: AbortSignal;
  readonly planOptions?: CraftPlanOptions;
  /** Replaced in tests: setting a block down needs a world. */
  readonly place?: typeof placeCarriedBlockNearby;
}

/** Within this many blocks of a table a craft opens it (the same bound `findBlock` uses to look for one). */
const TABLE_REACH = 4;

/** Walk back within reach of a table a reflex moved the bot away from; a table already in reach costs nothing. */
export async function reachCraftingTable(
  bot: Bot,
  navigation: NavigationRuntime,
  table: WorldBlock,
  signal?: AbortSignal,
): Promise<void> {
  if (bot.entity.position.distanceTo(table.position) <= TABLE_REACH) return;
  await navigation.navigate({ movements: createMovements(bot), goal: nearGoal(table.position, 2), signal });
}

/** The table this request set down earlier, while it still stands; a different block there means it is gone. */
function keptTable(bot: Bot, hold: TableHold): WorldBlock | null {
  if (!hold.placedAt) return null;
  const there = bot.blockAt(new Vec3(hold.placedAt.x, hold.placedAt.y, hold.placedAt.z));
  return there?.name === "crafting_table" ? (there as WorldBlock) : null;
}

/** Obtain a usable table without spending the batch's reserved ingredients. */
export async function prepareCraftingStation(
  bot: Bot,
  items: readonly CraftTarget[],
  required: boolean,
  { hold, signal, planOptions = {}, place = placeCarriedBlockNearby }: StationOptions,
): Promise<CraftingStation> {
  if (!required) return { kind: "ready", craftingTable: null };
  const kept = keptTable(bot, hold);
  if (kept) return { kind: "ready", craftingTable: kept };
  const nearby = bot.findBlock({ matching: bot.registry.blocksByName.crafting_table!.id, maxDistance: 4 });
  if (nearby) return { kind: "ready", craftingTable: nearby };
  const carriedBefore = carriedCount(bot, "crafting_table");
  if (carriedBefore === 0) {
    const definition = bot.registry.itemsByName.crafting_table!;
    const table = { id: definition.id, name: definition.name, count: 1 };
    const joint = planCraftingFromInventory(bot, [table, ...items], planOptions);
    if (joint.kind !== "ready") return { kind: "plan_failed", preparation: joint };
    const bootstrap = planCraftingFromInventory(bot, [table], planOptions);
    if (bootstrap.kind !== "ready") return { kind: "plan_failed", preparation: bootstrap };
    const made = await executeCraftPlan(bot, bootstrap.applications, null, signal);
    if (made.kind === "failed") return { kind: "failed", error: craftItemOutcomes.executionFailed(made.cause, carriedCount(bot, "unknown")) };
    const observed = await settleInventoryCount(bot, table.name, 1, { signal });
    if (observed.count < 1)
      return { kind: "failed", error: "The crafting table made for this batch was not observed." };
  }
  // Kept before the placement can throw an abort: a block set in that wait is this request's table, found again by the next attempt.
  const keepCell = (cell: Vec3) => {
    hold.placedAt = { x: cell.x, y: cell.y, z: cell.z };
  };
  const placement = await place(bot, "crafting_table", { signal, onCellChosen: keepCell });
  if (placement.kind !== "placed") {
    hold.placedAt = null;
    return { kind: "failed", error: craftItemOutcomes.craftingTableRequired };
  }
  hold.placedAt = { x: placement.position.x, y: placement.position.y, z: placement.position.z };
  // Counted before the wait below can throw an abort.
  hold.usedCarried += carriedBefore > 0 ? 1 : 0;
  await settleInventoryCount(bot, "crafting_table", Math.max(0, carriedBefore - 1), { signal });
  return { kind: "ready", craftingTable: placement.block };
}
