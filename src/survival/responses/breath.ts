import type { Bot } from "mineflayer";
import type { Vec3 } from "vec3";
import { horizontalControlsToward } from "../../navigation/index.js";
import { selectHarvestTool } from "../../navigation/mineflayer/movement-policy.js";
import { waitForPhysicsTicks } from "../../utils/physics-ticks.js";
import { airSupplyPoints, FULL_AIR_POINTS, isInWater } from "../perception/body.js";
import { routeCellReached, routeVerticalControls, swimBreathRoute, swimCellKey, swimmingRoof } from "../positioning/swim-escape.js";
import type { Budgets } from "../state/budgets.js";

/** A cell of the swim to air that is not closed in this long (one second) marks that way blocked. */
const CELL_STALL_TICKS = 20;
/** After this many blocked ways the reflex digs up instead of asking for another. */
const BLOCKED_WAYS_BEFORE_DIGGING = 2;
const TICK_MS = 50;
/** The wall clock allows this many times the tick budget, so a stopped physics clock cannot hold the body. */
const WALL_CLOCK_FACTOR = 2;

/**
 * Rise for air: swim the nearest way to a breathable cell (an air pocket or an open column, up and down included,
 * cell by cell), give up a way that stalls for the next, and with none left dig up through the roof, until the bar is
 * full or the time (ticks, and the wall clock beside them) is up.
 */
export async function surface(bot: Bot, signal: AbortSignal, budgets: Budgets, maximumTicks: number) {
  let dug = 0;
  let ticks = 0;
  const tick = () => {
    ticks++;
  };
  using budget = budgets.attempt({
    name: "surface.rise",
    scope: "surface",
    unit: "ticks",
    limit: maximumTicks,
    measure: () => ticks,
    exhaustion: "stuck",
  });
  let route: Vec3[] | null = null;
  let next = 0;
  let cellTicks = 0;
  let blockedWays = 0;
  const closedCells = new Set<string>();
  let jumping = true;
  let sneaking = false;
  signal.throwIfAborted();
  const stopDigging = () => {
    if (bot.targetDigBlock) bot.stopDigging();
  };
  signal.addEventListener("abort", stopDigging, { once: true });
  // The wall clock and a death end the waits even when physics ticks have stopped.
  const ended = new AbortController();
  const end = () => ended.abort();
  const wallClock = setTimeout(end, maximumTicks * TICK_MS * WALL_CLOCK_FACTOR);
  bot.once("death", end);
  bot.once("respawn", end);
  bot.on("physicsTick", tick);
  bot.setControlState("jump", true);
  try {
    while (!budget.exhausted && !ended.signal.aborted) {
      signal.throwIfAborted();
      const air = airSupplyPoints(bot);
      // Respawn can replace the body's metadata. Unknown air cannot retain
      // ownership on the strength of an old oxygenLevel value.
      if (air === null || air >= FULL_AIR_POINTS) break;
      const roof = isInWater(bot) ? swimmingRoof(bot) : null;
      if (bot.health <= 0) break;
      if (route && next < route.length) {
        if (routeCellReached(bot.entity.position, route[next]!)) {
          next++;
          cellTicks = 0;
        } else if (++cellTicks >= CELL_STALL_TICKS) {
          closedCells.add(swimCellKey(route[next]!.floored()));
          blockedWays++;
          route = null;
        }
      }
      if (roof && !route && blockedWays < BLOCKED_WAYS_BEFORE_DIGGING) {
        route = swimBreathRoute(bot, closedCells);
        next = 0;
        cellTicks = 0;
      }
      const target = route?.[next] ?? null;
      const horizontal = target ? horizontalControlsToward(bot.entity, target, 0.05) : null;
      for (const control of ["forward", "back", "left", "right"] as const)
        bot.setControlState(control, horizontal?.[control] ?? false);
      const vertical = target ? routeVerticalControls(bot, target, next === route!.length - 1) : { jump: true, sneak: false };
      if (vertical.jump !== jumping) bot.setControlState("jump", (jumping = vertical.jump));
      if (vertical.sneak !== sneaking) bot.setControlState("sneak", (sneaking = vertical.sneak));
      // No way to air within reach (or each tried one stalled): dig up through the roof, with the best tool carried.
      // The reflex digs by the body in the water, never by the route policy, so its rule against mining under water
      // does not apply here.
      if (roof?.diggable && !route) {
        try {
          const tool = selectHarvestTool(bot, roof);
          if (tool && bot.heldItem?.name !== tool.name) await bot.equip(tool, "hand");
          await bot.dig(roof);
          dug += 1;
        } catch {
          signal.throwIfAborted();
          // A refused dig yields one tick before another attempt.
        }
      }
      try {
        await waitForPhysicsTicks(bot, 1, AbortSignal.any([signal, ended.signal]));
      } catch {
        signal.throwIfAborted();
      }
    }
  } finally {
    clearTimeout(wallClock);
    bot.off("death", end);
    bot.off("respawn", end);
    bot.off("physicsTick", tick);
    signal.removeEventListener("abort", stopDigging);
    for (const control of ["jump", "sneak", "forward", "back", "left", "right"] as const) bot.setControlState(control, false);
  }

  const airAfter = airSupplyPoints(bot);
  return {
    kind:
      bot.health <= 0
        ? ("bot_died" as const)
        : airAfter === null
          ? ("air_unknown" as const)
          : airAfter >= FULL_AIR_POINTS
            ? ("air_full" as const)
            : ("stuck" as const),
    dug,
    airAfter,
  };
}
