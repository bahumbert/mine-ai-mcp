// Giving an item to a player (give_item): walk up to them, then drop it at them.
import type { SkillContext, SkillResult } from "../skills.ts";
import { come } from "./follow.ts";
import { once } from "./single-action.ts";

export async function giveItem(context: SkillContext, player: string, item: string, count: number): Promise<SkillResult> {
  const approach = await come(context, player);
  if (approach.status !== "done") return approach;
  return once(context, "drop_item", { items: [{ item_name: item, count }], to_player: player }, `${player} asked me for ${item}.`, `gave ${count} ${item} to ${player}`);
}
