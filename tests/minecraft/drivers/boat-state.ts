/** How the boat drivers (cancel-mid-ride, cancel-after-get-off) tell a boat from another entity and count the boats a bot carries. Not a driver: no scenario names it. */
import type { Bot } from "mineflayer";

/** Whether this entity or item name is a boat or a raft of any wood (drivers do not import `src/`: this mirrors `isBoatItemName`). */
export const boatNamed = (name: string | undefined) => name !== undefined && (name.endsWith("_boat") || name.endsWith("_raft"));

/** Boats and rafts in the bot's inventory, of any wood. */
export const carriedBoats = (bot: Bot) => bot.inventory.items().filter((item) => boatNamed(item.name)).reduce((sum, item) => sum + item.count, 0);
