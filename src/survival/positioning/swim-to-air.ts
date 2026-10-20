/**
 * The swim a pinned bot starts its escape with when it is in water (see `session/pinned-escape.ts`): to the nearest cell
 * where the head is in air, the way the breath reflex swims, but without waiting for the air bar to drop.
 */
import type { Bot } from "mineflayer";
import { horizontalControlsToward } from "../../navigation/index.js";
import { waitForPhysicsTicks } from "../../utils/physics-ticks.js";
import { AirRoute } from "./air-route.js";
import { routeVerticalControls } from "./swim-escape.js";

/** The swim to a breathable cell gives up after this long on the wall clock, whatever the physics clock does. */
const SWIM_WALL_MS = 20_000;
const CONTROLS = ["forward", "back", "left", "right", "jump", "sneak"] as const;

/**
 * Swims to the nearest breathable cell (an air pocket or an open column's surface, up and down included) cell by cell
 * along an {@link AirRoute} (the breath reflex's own: a way the body stops getting nearer to is given up for the next,
 * as many times as ways remain), until the head is in air, no way is left, or the wall clock is up. Returns with every
 * control released; rethrows the cancel of `signal`.
 */
export async function swimToBreathableCell(bot: Bot, signal: AbortSignal, wallMs = SWIM_WALL_MS): Promise<void> {
  const deadline = AbortSignal.timeout(wallMs);
  const stop = AbortSignal.any([signal, deadline]);
  const route = new AirRoute(Number.POSITIVE_INFINITY);
  try {
    route.update(bot, true);
    for (let cell = route.target; cell !== null; cell = route.target) {
      const horizontal = horizontalControlsToward(bot.entity, cell, 0.05);
      const vertical = routeVerticalControls(bot, cell, route.onLastCell);
      for (const control of ["forward", "back", "left", "right"] as const) bot.setControlState(control, horizontal[control] ?? false);
      bot.setControlState("jump", vertical.jump);
      bot.setControlState("sneak", vertical.sneak);
      await waitForPhysicsTicks(bot, 1, stop);
      route.update(bot, true);
    }
  } catch (cause) {
    // The wall clock ending the swim is not a failure of the escape: the routes that follow try on.
    signal.throwIfAborted();
    if (!deadline.aborted) throw cause;
  } finally {
    for (const control of CONTROLS) bot.setControlState(control, false);
  }
}
