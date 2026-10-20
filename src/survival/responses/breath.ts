import type { Bot } from "mineflayer";
import { horizontalControlsToward, longestBreakDurationMs, SWIM_UP_TICKS } from "../../navigation/index.js";
import { selectHarvestTool } from "../../navigation/mineflayer/movement-policy.js";
import { waitForPhysicsTicks } from "../../utils/physics-ticks.js";
import { airSupplyTicks } from "../../world/air-supply.js";
import { airSupplyPoints, FULL_AIR_POINTS, isInWater } from "../perception/body.js";
import { routeVerticalControls, swimmingRoof } from "../positioning/swim-escape.js";
import type { Budgets } from "../state/budgets.js";
import { AirRoute } from "../positioning/air-route.js";

const TICK_MS = 50;
/** The wall clock allows this many times the tick budget, so a stopped physics clock cannot hold the body. */
const WALL_CLOCK_FACTOR = 2;
/** Minecraft's drowning: once the air passes -20 the body takes 2 damage and the air starts over from 0. */
const DROWNING_DAMAGE_INTERVAL_TICKS = 20;
const DROWNING_DAMAGE = 2;

/** What became of the roof over a drowning swimmer in one surfacing: none to dig, dug, or too slow to start. */
export type RoofDig = "none" | "dug" | "too_slow";

type Roof = NonNullable<ReturnType<typeof swimmingRoof>>;

/**
 * Rise for air: swim the nearest way to a breathable cell (an air pocket or an open column, up and down included,
 * cell by cell), give up a way that stalls for the next, and with none left dig up through the roof when the dig can
 * end in time, until the bar is full or the time (ticks, and the wall clock beside them) is up.
 */
export async function surface(bot: Bot, signal: AbortSignal, budgets: Budgets, maximumTicks: number) {
  let dug = 0;
  let roofDig: RoofDig = "none";
  let ticks = 0;
  using budget = budgets.attempt({
    name: "surface.rise",
    scope: "surface",
    unit: "ticks",
    limit: maximumTicks,
    measure: () => ticks,
    exhaustion: "stuck",
  });
  const route = new AirRoute();
  let jumping = true;
  let sneaking = false;
  signal.throwIfAborted();
  // The wall clock, the tick budget and a death end the attempt even mid-dig, and even when physics ticks have stopped.
  const ended = new AbortController();
  const end = () => ended.abort();
  const tick = () => {
    ticks++;
    if (budget.exhausted) end();
  };
  const stop = AbortSignal.any([signal, ended.signal]);
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
      route.update(bot, roof !== null);
      const target = route.target;
      const horizontal = target ? horizontalControlsToward(bot.entity, target, 0.05) : null;
      for (const control of ["forward", "back", "left", "right"] as const)
        bot.setControlState(control, horizontal?.[control] ?? false);
      const vertical = target ? routeVerticalControls(bot, target, route.onLastCell) : { jump: true, sneak: false };
      if (vertical.jump !== jumping) bot.setControlState("jump", (jumping = vertical.jump));
      if (vertical.sneak !== sneaking) bot.setControlState("sneak", (sneaking = vertical.sneak));
      // No way to air within reach (or each tried one stalled): dig up through the roof, with the best tool carried.
      // The reflex digs by the body in the water, never by the route policy, so its rule against mining under water
      // does not apply here. A dig that cannot end in time is not started: the stalled ways are tried once more.
      if (roof?.diggable && route.none) {
        const result = await digRoof(bot, roof, stop);
        if (result === "dug") {
          dug += 1;
          roofDig = "dug";
        } else if (result === "too_slow" && roofDig === "none") {
          roofDig = "too_slow";
          route.reopenClosedWays();
        }
        signal.throwIfAborted();
      }
      try {
        await waitForPhysicsTicks(bot, 1, stop);
      } catch {
        signal.throwIfAborted();
      }
    }
  } finally {
    clearTimeout(wallClock);
    bot.off("death", end);
    bot.off("respawn", end);
    bot.off("physicsTick", tick);
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
    roofDig,
    airAfter,
  };
}

/**
 * Digs the roof with the best tool carried when the dig can end in time (see {@link roofDigFits}); `stop` (the claim's
 * cancel, the attempt's wall clock, its tick budget, a death) stops the equip wait and the dig. "failed" is a dig the
 * server or Mineflayer refused or that `stop` cut: the loop yields a tick and looks again.
 */
async function digRoof(bot: Bot, roof: Roof, stop: AbortSignal): Promise<"dug" | "too_slow" | "failed"> {
  const tool = selectHarvestTool(bot, roof);
  if (!roofDigFits(bot, roof, tool?.type ?? null)) return "too_slow";
  let digging = false;
  const stopDigging = () => {
    if (digging) bot.stopDigging();
  };
  stop.addEventListener("abort", stopDigging, { once: true });
  try {
    if (tool && bot.heldItem?.name !== tool.name) await untilStopped(bot.equip(tool, "hand"), stop);
    stop.throwIfAborted();
    digging = true;
    await bot.dig(roof);
    return "dug";
  } catch {
    return "failed";
  } finally {
    digging = false;
    stop.removeEventListener("abort", stopDigging);
  }
}

/**
 * Whether the roof dig and the rise through it end before the body has drowned past half its health: the air left,
 * then one hit of drowning a second, for at most half the health (owner 2026-10-19, Q2; run 16 Yuki: a stone roof by
 * hand under water, about 190 s, was dug until she died). The dig time is the worst case for a body in water.
 */
export function roofDigFits(bot: Bot, roof: Roof, toolType: number | null): boolean {
  const digMs = longestBreakDurationMs(bot, roof.position, toolType);
  if (digMs === null) return false;
  const air = Math.max(0, airSupplyTicks(bot) ?? 0);
  const drowningHits = Math.floor(bot.health / 2 / DROWNING_DAMAGE);
  return Math.ceil(digMs / TICK_MS) + SWIM_UP_TICKS <= air + drowningHits * DROWNING_DAMAGE_INTERVAL_TICKS;
}

/** `work`, or a rejection with `signal`'s reason as soon as it aborts; the listener goes either way. */
async function untilStopped<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  // Abandoned on a stop, `work` may still reject later: that rejection is no longer anyone's.
  work.catch(() => undefined);
  let onAbort = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
