// Charge a bow using the server's observed pace, keeping each caller's interruption and release decisions.
import type { Bot } from "mineflayer";
import { monotonicNow } from "../../utils/index.js";
import { waitForPhysicsTicks } from "../../utils/physics-ticks.js";
import { serverTickPace } from "../../world/server-tick-pace.js";
import { serverPacedWallMs } from "../../world/world-age.js";
import { BOW_DRAW_TICKS } from "./equipment.js";
import type { BowDraw } from "./item-use.js";

/** A bounded duration estimate, not a server receipt; the caller owns release or scope cancellation. */
export async function drawUntilFull<Exit extends string>(
  bot: Bot,
  draw: BowDraw,
  turn: (remainingServerTicks: number) => Promise<Exit | "continue">,
  signal: AbortSignal,
  nextTick = () => waitForPhysicsTicks(bot, 1, signal),
): Promise<Exit | "full"> {
  const pace = serverTickPace(bot);
  let clientTicks = 0;
  for (;;) {
    signal.throwIfAborted();
    const remaining = Math.max(0, BOW_DRAW_TICKS - pace.creditedSince(draw.startedAt));
    const result = await turn(remaining);
    if (result !== "continue") return result;
    signal.throwIfAborted();
    if (pace.ready(draw.startedAt, BOW_DRAW_TICKS, clientTicks) ||
        monotonicNow() - draw.startedAt.ms >= serverPacedWallMs(BOW_DRAW_TICKS)) return "full";
    await nextTick();
    clientTicks++;
  }
}
