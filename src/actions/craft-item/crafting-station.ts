import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { createMovements, nearGoal, type NavigationRuntime } from "../../navigation/index.js";
import { planCraftingFromInventory, type CraftPlanOptions, type CraftPreparation, type CraftTarget } from "../../utils/craft-plan.js";
import type { Position3 } from "../../utils/index.js";
import {
  awaitOwnPlacement,
  carriedCount,
  forgetPlacement,
  placeCarriedBlockNearby,
  recordPlacementSent,
  settleInventoryCount,
  startOwnPlacement,
  type OwnPlacement,
  type WorldBlock,
} from "../../world/index.js";
import { executeCraftPlan } from "../../world/crafting.js";
import { CRAFTING_STATION } from "../../world/workstations.js";
import { craftItemOutcomes } from "./contract.js";

type CraftingStation =
  | { readonly kind: "ready"; readonly craftingTable: WorldBlock | null }
  | { readonly kind: "failed"; readonly error: string }
  | { readonly kind: "plan_failed"; readonly preparation: Exclude<CraftPreparation, { kind: "ready" }> };

/** The table one craft request set down, kept across attempts so a resume goes back to it instead of making another. */
export interface TableHold {
  /** Where this request's own placement packet for the table went: only a table put down there is the request's. */
  readonly own: OwnPlacement;
  /** Tables the request put down, carried or crafted for the batch (counted as gained when it asks for a table). */
  usedCarried: number;
}

interface StationOptions {
  readonly hold: TableHold;
  readonly signal?: AbortSignal;
  readonly planOptions?: CraftPlanOptions;
  /** Hears each craft call the station makes for itself (its table), so a request that asks for that item credits it. */
  readonly onCrafted?: Parameters<typeof executeCraftPlan>[4];
  /** Replaced in tests: setting a block down needs a world. */
  readonly place?: typeof placeCarriedBlockNearby;
}

/** The table a craft request sets down and the temporary workstation holds: the item the request credits and recovers. */
export const CRAFTING_TABLE_ITEM = CRAFTING_STATION;

export function startTableHold(): TableHold {
  return { own: startOwnPlacement(), usedCarried: 0 };
}

/** The cell this request's table was sent to, if it sent one. */
export function placedTableAt(hold: TableHold): Position3 | undefined {
  const cell = hold.own.cells[0];
  return cell && { x: cell.x, y: cell.y, z: cell.z };
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

/**
 * The table this request's own packet set down earlier, as the server answered it: ready while it stands, a failure
 * that says where to go when its chunk is not loaded, null when none was sent or it never landed (then forgotten).
 */
async function keptTable(bot: Bot, hold: TableHold, signal?: AbortSignal): Promise<CraftingStation | null> {
  const seen = await awaitOwnPlacement(bot, hold.own, (block) => block.name === CRAFTING_TABLE_ITEM, signal);
  switch (seen.kind) {
    case "landed":
      return { kind: "ready", craftingTable: seen.block };
    case "unloaded":
      return { kind: "failed", error: craftItemOutcomes.tableNotLoaded(seen.cell) };
    case "not_landed":
      forgetPlacement(hold.own);
      return null;
    case "none":
      return null;
  }
}

/** Obtain a usable table without spending the batch's reserved ingredients. */
export async function prepareCraftingStation(
  bot: Bot,
  items: readonly CraftTarget[],
  required: boolean,
  { hold, signal, planOptions = {}, onCrafted, place = placeCarriedBlockNearby }: StationOptions,
): Promise<CraftingStation> {
  if (!required) return { kind: "ready", craftingTable: null };
  const kept = await keptTable(bot, hold, signal);
  if (kept) return kept;
  const nearby = bot.findBlock({ matching: bot.registry.blocksByName[CRAFTING_TABLE_ITEM]!.id, maxDistance: TABLE_REACH });
  if (nearby) return { kind: "ready", craftingTable: nearby };
  const carriedBefore = carriedCount(bot, CRAFTING_TABLE_ITEM);
  if (carriedBefore === 0) {
    const definition = bot.registry.itemsByName[CRAFTING_TABLE_ITEM]!;
    const table = { id: definition.id, name: definition.name, count: 1 };
    const joint = planCraftingFromInventory(bot, [table, ...items], planOptions);
    if (joint.kind !== "ready") return { kind: "plan_failed", preparation: joint };
    const bootstrap = planCraftingFromInventory(bot, [table], planOptions);
    if (bootstrap.kind !== "ready") return { kind: "plan_failed", preparation: bootstrap };
    const made = await executeCraftPlan(bot, bootstrap.applications, null, signal, onCrafted);
    if (made.kind === "failed") return { kind: "failed", error: craftItemOutcomes.executionFailed(made.cause, carriedCount(bot, "unknown")) };
    const observed = await settleInventoryCount(bot, table.name, 1, { signal });
    if (observed.count < 1)
      return { kind: "failed", error: "The crafting table made for this batch was not observed." };
  }
  // Recorded at the send, before the placement can throw an abort: a block set in that wait is this request's table,
  // found again by the next attempt. An abort before the send records nothing.
  const sent = (cells: readonly Vec3[]) => recordPlacementSent(hold.own, cells, bot.time?.age);
  const placement = await place(bot, CRAFTING_TABLE_ITEM, { signal, onPlacementSent: sent });
  if (placement.kind !== "placed") {
    forgetPlacement(hold.own);
    return { kind: "failed", error: craftItemOutcomes.craftingTableRequired };
  }
  // Counted before the wait below can throw an abort (a table crafted just now was carried for a moment too).
  hold.usedCarried += 1;
  await settleInventoryCount(bot, CRAFTING_TABLE_ITEM, Math.max(0, carriedBefore - 1), {
    ...(signal && { signal }),
    ...(hold.own.sentAtAge !== undefined && { sentAtAge: hold.own.sentAtAge }),
  });
  return { kind: "ready", craftingTable: placement.block };
}
