/** Whether a block the mine process broke should have dropped an item, from the registry and the version's loot tables. */
import type { Bot } from "mineflayer";
import { type DropExpectation, expectedDrop } from "../../../world/block-drops.js";
import { enchantmentsOf } from "../../../world/enchantments.js";
import { selectHarvestTool } from "../../mineflayer/movement-policy.js";
import type { MinecraftBlock } from "./mine-process.js";

/**
 * Whether breaking `block` (read before it came down) should leave an item behind.
 *
 * The tool is the one the bot digs this block with (`selectHarvestTool`, the fastest carried), not the held item: the
 * break is noticed up to a scan later, when the bot may already hold the tool of the next block.
 * Two data sources answer in turn: the registry's harvest tools (stone by hand drops nothing, whatever its loot
 * table says) and the version's loot tables (`world/block-drops.ts`: leaves without shears, a door's upper half).
 * `unknown` when the version ships no table for the block: the caller then counts the break as it did before.
 */
export function expectedDropOfBreak(bot: Bot, block: MinecraftBlock): DropExpectation {
  const tool = selectHarvestTool(bot, block);
  if (!block.canHarvest(tool?.type ?? null)) return "nothing";
  const state = Object.fromEntries(Object.entries(block.getProperties()).map(([property, value]) => [property, String(value)]));
  return expectedDrop(block.name, bot.version, {
    heldItem: tool?.name ?? null,
    silkTouch: enchantmentsOf(bot, tool).some((enchantment) => enchantment.name === "silk_touch"),
    state,
  });
}
