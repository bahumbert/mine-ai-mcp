/**
 * The swim a pinned bot starts its escape with when it is in water (see `session/pinned-escape.ts`): to the nearest cell
 * where the head is in air, the way the breath reflex swims, but without waiting for the air bar to drop.
 */
import type { Bot } from "mineflayer";
import type { Vec3 } from "vec3";
import { horizontalControlsToward } from "../../navigation/index.js";
import { waitForPhysicsTicks } from "../../utils/physics-ticks.js";
import { routeCellReached, routeVerticalControls, swimBreathRoute, swimCellKey } from "./swim-escape.js";

/** The swim to a breathable cell gives up after this long on the wall clock, whatever the physics clock does. */
const SWIM_WALL_MS = 20_000;
/** A cell of the swim that is not reached in this many ticks (one second) closes that way for the next ask. */
const CELL_STALL_TICKS = 20;
const CONTROLS = ["forward", "back", "left", "right", "jump", "sneak"] as const;

/**
 * Swims to the nearest breathable cell (an air pocket or an open column's surface, up and down included) cell by cell,
 * giving up a way whose cell stalls for the next, until the head is in air, no way is left, or the wall clock is up.
 * Returns with every control released; rethrows the cancel of `signal`.
 */
export async function swimToBreathableCell(bot: Bot, signal: AbortSignal, wallMs = SWIM_WALL_MS): Promise<void> {
  const deadline = AbortSignal.timeout(wallMs);
  const stop = AbortSignal.any([signal, deadline]);
  const closed = new Set<string>();
  let route: Vec3[] | null = swimBreathRoute(bot, closed);
  let next = 0;
  let cellTicks = 0;
  try {
    while (route !== null && next < route.length) {
      const cell = route[next]!;
      if (routeCellReached(bot.entity.position, cell)) {
        next += 1;
        cellTicks = 0;
        continue;
      }
      if (++cellTicks > CELL_STALL_TICKS) {
        closed.add(swimCellKey(cell.floored()));
        route = swimBreathRoute(bot, closed);
        next = 0;
        cellTicks = 0;
        continue;
      }
      const horizontal = horizontalControlsToward(bot.entity, cell, 0.05);
      const vertical = routeVerticalControls(bot, cell, next === route.length - 1);
      for (const control of ["forward", "back", "left", "right"] as const) bot.setControlState(control, horizontal[control] ?? false);
      bot.setControlState("jump", vertical.jump);
      bot.setControlState("sneak", vertical.sneak);
      await waitForPhysicsTicks(bot, 1, stop);
    }
  } catch (cause) {
    // The wall clock ending the swim is not a failure of the escape: the routes that follow try on.
    signal.throwIfAborted();
    if (!deadline.aborted) throw cause;
  } finally {
    for (const control of CONTROLS) bot.setControlState(control, false);
  }
}
