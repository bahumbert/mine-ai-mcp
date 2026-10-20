import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { horizontalControlsToward, isHeadPassable, isPassable, type WorldView } from "../../navigation/index.js";
import { preferredScaffoldItem } from "../../navigation/mineflayer/movement-policy.js";
import { waitForPhysicsTicks } from "../../utils/physics-ticks.js";
import { advancingLavaAt } from "../../world/lava-flow.js";
import { occupiedCell, placeSolidBlockInto } from "../../world/placement.js";
import { fireContactCells, isBurning, isInFire, isInLava } from "../perception/body.js";
import { extinguishFireAt } from "../positioning/fire-clearance.js";
import {
  clearFireEscape,
  fireEscapeDeparture,
  fireEscapeRoute,
  type FireEscapeDeparture,
  SIDE_STEPS,
  type FireEscapeReason,
} from "../positioning/fire-escape.js";

/** `timed_out`: the wall clock ended the walk (15 s of burning), as against `blocked`: no way on. */
export type FireEscapeOutcome = "escaped" | "blocked" | "timed_out" | "died";

/**
 * The lava cells beside the body that a solid block can replace: lava by its traits, no creature in the cell, and room
 * above it to stand (a passable, harmless cell for the feet and one the head fits in).
 */
export function lavaStepCells(bot: Bot, world: WorldView): Vec3[] {
  const origin = bot.entity.position.floored();
  return SIDE_STEPS.map(([dx, dz]) => origin.offset(dx, 0, dz)).filter((cell) => {
    const block = world.blockAt(cell.x, cell.y, cell.z);
    if (block.kind !== "loaded" || block.traits.liquid !== "lava" || occupiedCell(bot, cell)) return false;
    const feet = world.blockAt(cell.x, cell.y + 1, cell.z);
    const head = world.blockAt(cell.x, cell.y + 2, cell.z);
    return (
      feet.kind === "loaded" &&
      isPassable(feet) &&
      feet.traits.liquid === null &&
      !feet.traits.damaging &&
      head.kind === "loaded" &&
      isHeadPassable(head) &&
      head.traits.liquid === null &&
      !head.traits.damaging
    );
  });
}

/** Replace adjacent lava with a solid step when there is no natural bank to climb. */
export async function buildLavaEscapeStep(bot: Bot, world: WorldView, signal: AbortSignal): Promise<Vec3 | null> {
  const item = preferredScaffoldItem(bot);
  if (!item) return null;
  for (const cell of lavaStepCells(bot, world)) {
    signal.throwIfAborted();
    const placed = await placeSolidBlockInto(bot, cell, item, { signal });
    if (placed.kind === "placed") return cell.offset(0.5, 1, 0.5);
  }
  return null;
}

/** Lava burns for 15 s: a fire escape that has not ended by then hands the body back, on the wall clock beside the ticks. */
export const FIRE_ESCAPE_MAXIMUM_MS = 15_000;

/** The cells being walked: the body steers to `route[next]`, which `departure` says how it was left. */
interface FireWalk {
  readonly route: readonly Vec3[];
  readonly next: number;
  readonly departure: FireEscapeDeparture;
  /** Closest distance to `route[next]` so far, to see a stall. */
  readonly best: number;
}

function newFireWalk(bot: Bot, route: readonly Vec3[] | null): FireWalk {
  return { route: route ?? [], next: 0, departure: fireEscapeDeparture(bot), best: Infinity };
}

/** Residual burning on dry ground is worth leaving only for water: a route that ends in water (read from the world now). */
function routeEndsInWater(world: WorldView, route: readonly Vec3[]): boolean {
  const end = route.at(-1);
  if (!end) return false;
  const block = world.blockAt(Math.floor(end.x), Math.floor(end.y), Math.floor(end.z));
  return block.kind === "loaded" && block.traits.liquid === "water";
}

/** Out of fire and lava and not where lava can spread next: safe footing, whatever woke the reflex. */
function isOnSafeFooting(bot: Bot, inLava: boolean, inFire: boolean): boolean {
  return !inLava && !inFire && !advancingLavaAt(bot);
}

/** On safe footing, not burning, and standing or swimming: nothing is left to escape. */
function hasNothingLeftToEscape(bot: Bot, safeFooting: boolean): boolean {
  return safeFooting && !isBurning(bot) && (bot.entity.onGround || Reflect.get(bot.entity, "isInWater"));
}

function steerToward(bot: Bot, target: Vec3): void {
  const controls = horizontalControlsToward(bot.entity, target, 0.1);
  for (const control of ["forward", "back", "left", "right"] as const) bot.setControlState(control, controls[control]);
  bot.setControlState("jump", isInLava(bot) || target.y > bot.entity.position.y + 0.1);
}

/** On the ground at a route cell: go on to the next cell (a new departure), or ask for a fresh route at the end. */
function arriveAtCell(bot: Bot, world: WorldView, reason: FireEscapeReason, walk: FireWalk): FireWalk {
  if (walk.next + 1 >= walk.route.length) return newFireWalk(bot, fireEscapeRoute(bot, world, reason));
  return { ...walk, next: walk.next + 1, departure: fireEscapeDeparture(bot), best: Infinity };
}

/** Leave the active source; residual burning must not monopolise the body without reachable water. */
export async function escapeFire(
  bot: Bot,
  world: WorldView,
  signal: AbortSignal,
  reason: FireEscapeReason = "contact",
  { maximumMs = FIRE_ESCAPE_MAXIMUM_MS }: { maximumMs?: number } = {},
): Promise<FireEscapeOutcome> {
  bot.stopDigging();
  bot.deactivateItem();
  bot.clearControlStates();
  // The wall clock and a death end the waits even when physics ticks have stopped (as in breath's surfacing).
  const ended = new AbortController();
  const end = () => ended.abort();
  let timedOut = false;
  const wallClock = setTimeout(() => {
    timedOut = true;
    end();
  }, maximumMs);
  const endedOutcome = (): FireEscapeOutcome => (bot.health <= 0 ? "died" : timedOut ? "timed_out" : "blocked");
  bot.once("death", end);
  bot.once("respawn", end);
  const waits = AbortSignal.any([signal, ended.signal]);
  let walk = newFireWalk(bot, fireEscapeRoute(bot, world, reason));
  let stalled = 0;
  try {
    while (bot.health > 0 && !ended.signal.aborted) {
      signal.throwIfAborted();
      const inLava = isInLava(bot);
      const inFire = isInFire(bot);
      const safeFooting = isOnSafeFooting(bot, inLava, inFire);
      if (hasNothingLeftToEscape(bot, safeFooting)) return "escaped";
      // Keep the admitted departure through the jump. Being momentarily above
      // lava is not a landing, and must not invalidate the bank we are climbing.
      const hop = walk.route[walk.next];
      if (hop && !clearFireEscape(bot, world, hop, walk.departure)) walk = newFireWalk(bot, fireEscapeRoute(bot, world, reason));
      // There is no water in the Nether. Solid terrain can still replace a
      // lava cell and provide the bank the local swimming controller needs.
      if (walk.route.length === 0 && inLava) {
        const step = await buildLavaEscapeStep(bot, world, waits);
        walk = newFireWalk(bot, step && [step]);
      }
      if (walk.route.length === 0 && inFire) {
        // Environmental escape has its own authority, like the lava step.
        // A sealed refuge may offer no walk out, but its occupied fire can
        // still be extinguished without excavating any of the refuge's walls.
        for (const cell of fireContactCells(bot)) await extinguishFireAt(bot, cell, waits, true);
        if (!isInFire(bot)) continue;
      }
      if (safeFooting && bot.entity.onGround && !routeEndsInWater(world, walk.route)) return "escaped";
      const target = walk.route[walk.next];
      if (!target) return "blocked";
      const distance = bot.entity.position.distanceTo(target);
      if (distance < walk.best - 0.05) {
        walk = { ...walk, best: distance };
        stalled = 0;
      } else stalled++;
      // Two seconds without closing distance detects an obstructed jump out
      // of liquid. Release with evidence rather than retain a dead steering loop.
      if (stalled >= 40) return "blocked";
      steerToward(bot, target);
      await waitForPhysicsTicks(bot, 1, waits);
      if (distance < 0.4 && bot.entity.onGround && !Reflect.get(bot.entity, "isInWater"))
        walk = arriveAtCell(bot, world, reason, walk);
    }
    signal.throwIfAborted();
    return endedOutcome();
  } catch (error) {
    signal.throwIfAborted();
    if (!ended.signal.aborted) throw error;
    return endedOutcome();
  } finally {
    clearTimeout(wallClock);
    bot.off("death", end);
    bot.off("respawn", end);
    bot.clearControlStates();
  }
}
