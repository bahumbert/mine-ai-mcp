import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { enchantmentsOf } from "../../world/enchantments.js";
import { botEyesInWater } from "../../world/eyes-in-water.js";
import type { Position3 } from "../world/world.js";

/**
 * The longest the body can take to dig the block at `position` from the state it is in now, with the item type
 * `toolType` (bare hands when null): Mineflayer's own `bot.digTime` arithmetic with the enchantments of the tool and of
 * the helmet (aqua affinity) and the potion effects. A body with any part in water (`entity.isInWater`) is costed with
 * both of Minecraft's penalties, x5 in water and x5 off the ground, whatever its stance at this instant: buoyancy,
 * `holdWaterPosition`'s jump and surface bobbing lift it off a floor or dip it under before the swing, and the planner
 * prices the stance it plans (a body hovering over a solid cell is priced as standing). A dry body is read as it
 * stands (its eyes in water as the server decides it, `botEyesInWater`; `onGround`). The tool comes from the operation,
 * not from the hand, because the deadline is set before the tool is equipped. Null when the block is not loaded.
 */
export function longestBreakDurationMs(bot: Bot, position: Position3, toolType: number | null): number | null {
  const block = bot.blockAt(new Vec3(position.x, position.y, position.z));
  if (!block) return null;
  const tool = toolType === null ? null : (bot.inventory.items().find((item) => item.type === toolType) ?? null);
  const helmet = bot.inventory.slots[bot.getEquipmentDestSlot("head")] ?? null;
  const inWater = (bot.entity as Bot["entity"] & { readonly isInWater?: boolean }).isInWater === true;
  return block.digTime(
    toolType,
    bot.game.gameMode === "creative",
    inWater || botEyesInWater(bot),
    inWater || !bot.entity.onGround,
    [...enchantmentsOf(bot, tool), ...enchantmentsOf(bot, helmet)],
    Object.values(bot.entity.effects ?? {}),
  );
}

