/** What a connected bot does before a planned dig: the hand it digs with and the point it aims at. */
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { STANDING_EYE_HEIGHT, visibleBlockAim } from "../../world/block-visibility.js";
import { DIG_REACH } from "../movements/excavation.js";
import type { Position3 } from "../world/world.js";
import { observeMineflayerBlock } from "./world.js";

/**
 * Put a held tool (an item that wears out) away before a dig no tool speeds up: a pickaxe on dirt digs at hand speed
 * and still loses durability. Something that does not wear out goes in hand, else the hand is emptied.
 */
export async function putAwayHeldTool(bot: Bot): Promise<void> {
  const wears = (type: number) => (bot.registry.items[type]?.maxDurability ?? 0) > 0;
  const held = bot.heldItem;
  if (!held || !wears(held.type)) return;
  const plain = bot.inventory.items().find((candidate) => !wears(candidate.type));
  if (plain) await bot.equip(plain, "hand");
  else await bot.unequip("hand");
}

/** The point to aim at on the block at `position` within dig reach of the eyes, or null when no face is in view. */
export function visibleDigAim(bot: Bot, position: Position3): Position3 | null {
  const eyeHeight = (bot.entity as { readonly eyeHeight?: number }).eyeHeight ?? STANDING_EYE_HEIGHT;
  const target = bot.blockAt(new Vec3(position.x, position.y, position.z));
  if (!target) return null;
  return visibleBlockAim(
    bot.world,
    bot.entity.position.offset(0, eyeHeight, 0),
    position,
    DIG_REACH,
    observeMineflayerBlock(target).collisionShapes,
  );
}
