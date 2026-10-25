// Opens a furnace with its fuel and cook counters read from the raw window property packets.
import type { Bot } from "mineflayer";
import type { FurnaceWindow } from "./furnace-cook.js";

/** What the server says a furnace is doing, in ticks: its lit fuel and the item it is cooking. */
export interface FurnaceProperties {
  /** Ticks the lit fuel will still burn (0: not lit). */
  readonly litTicks: number;
  /** Ticks the current fuel item burns in all. */
  readonly litTotalTicks: number;
  /** Ticks the current item has cooked. */
  readonly cookTicks: number;
  /** Ticks the current item takes to cook. */
  readonly cookTotalTicks: number;
}

/** The furnace window properties the game numbers 0 to 3, in the order of `FurnaceProperties`. */
const PROPERTY_FIELDS = ["litTicks", "litTotalTicks", "cookTicks", "cookTotalTicks"] as const;

interface PropertyPacket {
  readonly windowId: number;
  readonly property: number;
  readonly value: number;
}

/**
 * Open the furnace and give its window `properties()`: what the server last said it is doing, null until it has said
 * anything. Mineflayer cannot be asked: it derives `fuel` and `progress` from a current and a total packet, reads 0 when
 * the current one comes first, and never learns the total when the packets of the opening burst were handled before its
 * listener was attached (verified live, busy-smelt-interrupted: `fuel 0, totalFuel null, progress null` on a furnace that
 * was lit and cooking, which read as `SMELT_FUEL_STARVED` and `SMELT_STALLED`). The listener here is attached before the
 * window opens, so no packet of the burst is missed.
 */
export async function openFurnaceWithProperties(bot: Bot, block: Parameters<Bot["openFurnace"]>[0]): Promise<FurnaceWindow> {
  const byWindow = new Map<number, FurnaceProperties>();
  const onProperty = (packet: PropertyPacket) => {
    const field = PROPERTY_FIELDS[packet.property];
    if (field === undefined) return;
    byWindow.set(packet.windowId, {
      litTicks: 0, litTotalTicks: 0, cookTicks: 0, cookTotalTicks: 0,
      ...byWindow.get(packet.windowId),
      [field]: packet.value,
    });
  };
  const client = bot._client;
  client.on("craft_progress_bar", onProperty);
  const stop = () => client.removeListener("craft_progress_bar", onProperty);
  try {
    const window = await bot.openFurnace(block);
    window.once("close", stop);
    return Object.assign(window, { properties: (): FurnaceProperties | null => byWindow.get(window.id) ?? null });
  } catch (cause) {
    stop();
    throw cause;
  }
}
