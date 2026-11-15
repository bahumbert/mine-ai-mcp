// Driver waits use the server's age, allowing for the last time packet already being stale.
import type { Bot } from "mineflayer";
import { waitForWorldAge, type WorldAgeWait } from "../../../src/world/world-age.ts";

/** Match the scenario daemon's stopped-clock bound, including room for slow time packets. */
export const DRIVER_CLOCK_STOPPED_MS = 30_000;

/** Wait at least `ticks` server ticks: world-age.ts's SERVER_ANSWER_TICKS documents the extra packet's margin. */
export function waitServerTicks(
  bot: Pick<Bot, "time">,
  ticks: number,
  options: { signal?: AbortSignal; until?: () => boolean; now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<WorldAgeWait> {
  return waitForWorldAge(bot, Math.ceil(ticks / 20) * 20 + 20, {
    wallMs: Number.POSITIVE_INFINITY,
    stallMs: DRIVER_CLOCK_STOPPED_MS,
    ...options,
  });
}
