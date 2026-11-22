import type { Bot } from "mineflayer";
import { isAutoEdibleFood } from "../../world/food.js";
import { OFF_HAND_SLOT } from "../../survival/weapons/equipment.js";
import { familyIndexOf } from "../../world/item-families.js";

export type PortalDestination = "overworld" | "the_nether" | "the_end";

export function portalSupplyWarning(bot: Bot, destination: PortalDestination): string | null {
  if (destination === "overworld") return null;
  const index = familyIndexOf(bot);
  let food = 0;
  let arrows = 0;
  const offHand = bot.inventory.slots[OFF_HAND_SLOT];
  for (const item of [...bot.inventory.items(), ...(offHand ? [offHand] : [])]) {
    if (isAutoEdibleFood(index, item.name)) food += item.count;
    if (index.itemFamilies(item.name).includes("arrow")) arrows += item.count;
  }
  return food < 16 || arrows < 32
    ? `[PORTAL_LOW_SUPPLIES] Portal entry paused: ${food}/16 auto-edible food items and ${arrows}/32 arrows (regular, spectral or tipped) carried. Set allow_low_supplies: true to continue regardless.`
    : null;
}
