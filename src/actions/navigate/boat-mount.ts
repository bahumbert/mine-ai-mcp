/** Getting into a boat: the wait for the server to seat her, bounded by world ticks and the wall clock. */
import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import { waitForWorldAge } from "../../world/world-age.js";
import { currentVehicle } from "./vehicle-sync.js";

/** Longest wait for the server to seat her in the boat, on the wall clock, next to the 40 server ticks. */
export const MOUNT_WALL_MS = 8_000;

/** Seat her in `boat`; false when no `mount` came within 40 server ticks or the wall bound. The listener never outlives the wait. */
export async function mountBoat(bot: Bot, boat: Entity, wallMs: number, signal?: AbortSignal): Promise<boolean> {
  let mounted = false;
  const onMount = () => {
    mounted = true;
  };
  bot.once("mount", onMount);
  try {
    bot.mount(boat);
    await waitForWorldAge(bot, 40, { wallMs, until: () => mounted, ...(signal && { signal }) });
  } finally {
    bot.off("mount", onMount);
  }
  // A seat the server gave after the wait (the vehicle shows it) is a ride: hitting the boat she sits in would eject her.
  return mounted || currentVehicle(bot)?.id === boat.id;
}
