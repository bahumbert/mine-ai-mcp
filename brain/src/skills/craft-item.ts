// Crafting one item (craft_item), with the table, the room and the materials it may be short of.
import type { Step } from "../actions.ts";
import { walkToStation } from "../gathering/stations.ts";
import { consumedBy, FULL_INVENTORY } from "../inventory-room.ts";
import type { SkillContext, SkillResult } from "../skills.ts";
import { makeRoom } from "./drop-items.ts";
import { getItems } from "./get-items.ts";
import { once } from "./single-action.ts";

/**
 * Crafts one item. A table close by is used where it stands; else the runtime sets a carried one down. With no room for
 * the result or the table, room is made from what the work does not need and the craft runs again; with no table
 * carried, one is made first (run 12: "needs inventory room to store 1 stone_shovel", "No crafting_table is carried").
 */
export async function craftItem(context: SkillContext, step: Extract<Step, { skill: "craft_item" }>, why: string): Promise<SkillResult> {
  await walkToStation(context, "crafting_table");
  const run = () => once(context, "craft_item", { items: [{ item_name: step.item, count: step.count }] }, why, `crafted ${step.count} ${step.item}`);
  const first = await run();
  if (first.status !== "failed") return first;
  if (FULL_INVENTORY.test(first.detail) && (await makeRoom(context, await consumedBy(context.runtime, "craft_item", { items: [{ item_name: step.item, count: step.count }] })))) return run();
  if (/WORKSTATION_NOT_CARRIED/u.test(first.detail)) {
    const table = await getItems(context, [{ item: "crafting_table", count: 1 }], `crafting ${step.item}`);
    if (table.status === "stopped") return table;
    return table.status === "done" ? run() : { status: "failed", detail: `${first.detail}; making a crafting table failed: ${table.detail}` };
  }
  // Run 12: 16 crafts lacked raw materials; get_items gathers them and crafts (one clear next step).
  return first.detail.includes("CRAFT_MATERIALS_MISSING")
    ? { status: "failed", detail: `${first.detail} craft only uses what you carry: \`get_items ${step.item} ${step.count}\` gathers the missing materials and crafts it.` }
    : first;
}
