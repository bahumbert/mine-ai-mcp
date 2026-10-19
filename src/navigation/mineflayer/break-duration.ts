import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { STANDING_EYE_HEIGHT } from "../../world/block-visibility.js";
import { enchantmentsOf } from "../../world/enchantments.js";
import type { Position3 } from "../world/world.js";

/**
 * The longest the body can take to dig the block at `position` from the state it is in now, with the item type
 * `toolType` (bare hands when null): Mineflayer's own `bot.digTime` arithmetic with the enchantments of the tool and of
 * the helmet (aqua affinity) and the potion effects. A body with any part in water (`entity.isInWater`) is costed with
 * both of Minecraft's penalties, x5 in water and x5 off the ground, whatever its stance at this instant: buoyancy,
 * `holdWaterPosition`'s jump and surface bobbing lift it off a floor or dip it under before the swing, and the planner
 * prices the stance it plans (a body hovering over a solid cell is priced as standing). A dry body is read as it
 * stands (the block at its eyes, `onGround`). The tool comes from the operation, not from the hand, because the
 * deadline is set before the tool is equipped. Null when the block is not loaded.
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
    inWater || areEyesInWater(bot),
    inWater || !bot.entity.onGround,
    [...enchantmentsOf(bot, tool), ...enchantmentsOf(bot, helmet)],
    Object.values(bot.entity.effects ?? {}),
  );
}

/** Mineflayer's own test for the water penalty: the block at eye level is water. */
function areEyesInWater(bot: Bot): boolean {
  const eyeHeight = (bot.entity as { readonly eyeHeight?: number }).eyeHeight ?? STANDING_EYE_HEIGHT;
  const name = bot.blockAt(bot.entity.position.offset(0, eyeHeight, 0))?.name;
  return name === "water" || name === "flowing_water";
}
