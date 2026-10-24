// Item lists as the trade code reads them: the words a side is told in, and what an inventory carries of an item.
import type { BotSnapshot } from "../runtime-client.ts";
import type { ItemCount } from "./types.ts";

/** "2 oak_log, 1 iron_ingot": one side of a trade, as the model and the logs read it. */
export const sideText = (items: readonly ItemCount[]): string => items.map((i) => `${i.count} ${i.item}`).join(", ");

/** How many of an item the inventory holds, over all its stacks. */
export const carriedOf = (inventory: BotSnapshot["inventory"], item: string): number => inventory.filter((s) => s.name === item).reduce((sum, s) => sum + s.count, 0);
