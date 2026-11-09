import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { bucketAvailable, horizontalControlsToward, isHeadPassable, isPassable, placeWaterInto, waterableLanding, type WorldView } from "../../navigation/index.js";
import { preferredScaffoldItem } from "../../navigation/mineflayer/movement-policy.js";
import { waitForPhysicsTicks } from "../../utils/physics-ticks.js";
import { advancingLavaAt } from "../../world/lava-flow.js";
import { occupiedCell, placeSolidBlockInto } from "../../world/placement.js";
import { bucketItem } from "../../world/buckets.js";
import { fireContactCells, isBurning, isInFire, isInLava } from "../perception/body.js";
import { extinguishFireAt } from "../positioning/fire-clearance.js";
import {
  clearFireEscape,
  fireEscapeDeparture,
  fireEscapeRoute,
  nearestDryCellToSwimTo,
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

/** A step tried from this body cell in this world revision: asking the server again for it cannot answer differently. */
function triedStepKey(bot: Bot, world: WorldView, cell: Vec3): string {
  return `${bot.entity.position.floored()}|${world.revision}|${cell}`;
}

/**
 * Replace adjacent lava with a solid step when there is no natural bank to climb. A cell already in `tried` (this body
 * cell, this world revision) is not asked again; each cell attempted is added, whatever the answer. `jump` is held
 * before the first placement: the wait for the server's answer takes seconds, and a body in lava must keep swimming up.
 */
export async function buildLavaEscapeStep(
  bot: Bot,
  world: WorldView,
  signal: AbortSignal,
  tried: Set<string> = new Set(),
): Promise<Vec3 | null> {
  const item = preferredScaffoldItem(bot);
  if (!item) return null;
  for (const cell of lavaStepCells(bot, world)) {
    signal.throwIfAborted();
    const key = triedStepKey(bot, world, cell);
    if (tried.has(key)) continue;
    tried.add(key);
    bot.setControlState("jump", true);
    const placed = await placeSolidBlockInto(bot, cell, item, { signal, lifeSaving: true });
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

/**
 * In lava with no hop admitted and no step to place: hold `jump`, which swims a body up in lava (Mineflayer's physics
 * rises while it is held), and steer toward `toward` (the nearest dry cell of the scan) or, with none, not at all.
 */
function swimUpInLava(bot: Bot, toward: Vec3 | null): void {
  const controls = toward && horizontalControlsToward(bot.entity, toward, 0.1);
  for (const control of ["forward", "back", "left", "right"] as const) bot.setControlState(control, controls?.[control] ?? false);
  bot.setControlState("jump", true);
}

/**
 * The body's exact position and the world's revision: what a route search reads, so it is made again only when one
 * changes. The exact position is the key because a hop is admitted or refused by where the body's width reaches, as in the
 * reflex's availability memo (`reflexes/fire.ts`, live 2026-10-19): the reflex and the escape then agree on "a way exists".
 */
function searchKey(bot: Bot, world: WorldView): string {
  return `${bot.entity.position}|${world.revision}`;
}

/** On the ground at a route cell: go on to the next cell (a new departure), or ask for a fresh route at the end. */
function arriveAtCell(bot: Bot, world: WorldView, reason: FireEscapeReason, walk: FireWalk): FireWalk {
  if (walk.next + 1 >= walk.route.length) return newFireWalk(bot, fireEscapeRoute(bot, world, reason));
  return { ...walk, next: walk.next + 1, departure: fireEscapeDeparture(bot), best: Infinity };
}

/**
 * The wall clock and a death end the waits even when physics ticks have stopped (as in breath's surfacing). `waits` is the
 * signal for every wait of the escape; `outcome` says why it ended; `release` removes the timer and the listeners.
 */
function startEscapeClock(bot: Bot, signal: AbortSignal, maximumMs: number) {
  const ended = new AbortController();
  const end = () => ended.abort();
  let timedOut = false;
  const wallClock = setTimeout(() => {
    timedOut = true;
    end();
  }, maximumMs);
  bot.once("death", end);
  bot.once("respawn", end);
  return {
    ended: ended.signal,
    waits: AbortSignal.any([signal, ended.signal]),
    outcome: (): FireEscapeOutcome => (bot.health <= 0 ? "died" : timedOut ? "timed_out" : "blocked"),
    release(): void {
      clearTimeout(wallClock);
      bot.off("death", end);
      bot.off("respawn", end);
    },
  };
}

/**
 * What a body in lava with no way out remembers between loops: where it last looked for one (the cell it floats in and
 * the world's revision), where to steer while it rises, and the lava steps already asked of the server.
 */
interface LavaSwim {
  searchedAt: string;
  toward: Vec3 | null;
  readonly triedSteps: Set<string>;
}

/**
 * A body in lava whose walk is empty: `jump` is held, a new route is searched only when its cell or the world changed
 * (it rose a cell, or the lava moved: a bank may be in reach now), and a lava step is asked of the server once per cell.
 */
async function wayOutOfLava(
  bot: Bot,
  world: WorldView,
  reason: FireEscapeReason,
  waits: AbortSignal,
  swim: LavaSwim,
): Promise<FireWalk> {
  bot.setControlState("jump", true);
  let walk = newFireWalk(bot, null);
  const at = searchKey(bot, world);
  if (at !== swim.searchedAt) {
    swim.searchedAt = at;
    walk = newFireWalk(bot, fireEscapeRoute(bot, world, reason));
    swim.toward = walk.route.length === 0 ? nearestDryCellToSwimTo(bot, world) : null;
  }
  if (walk.route.length > 0) return walk;
  const step = await buildLavaEscapeStep(bot, world, waits, swim.triedSteps);
  return newFireWalk(bot, step && [step]);
}

/** Make a refuge for a lethal burn, keeping the pour and its receipts inside the escape's body lifetime. */
async function pourBurnRefuge(bot: Bot, world: WorldView, signal: AbortSignal): Promise<FireWalk> {
  const feet = bot.entity.position.floored();
  const free = (cell: Vec3) => waterableLanding(world, cell) && !occupiedCell(bot, cell, bot.entity.id);
  const cell = [feet, ...SIDE_STEPS.map(([dx, dz]) => feet.offset(dx, 0, dz))].find(free);
  if (!cell || !await placeWaterInto(bot, cell, signal, () => free(cell), { lifeSaving: true })) return newFireWalk(bot, null);
  // A sent use_item is not a source receipt (bucket-pour-and-fill, 2026-10-23).
  while (true) {
    signal.throwIfAborted();
    if (hasNothingLeftToEscape(bot, isOnSafeFooting(bot, isInLava(bot), isInFire(bot)))) return newFireWalk(bot, null);
    const source = world.blockAt(cell.x, cell.y, cell.z);
    if (source.kind === "loaded" && source.traits.liquid === "water" && source.traits.liquidSource && bot.heldItem?.name === bucketItem("water", false))
      return newFireWalk(bot, [cell.offset(0.5, 0, 0.5)]);
    await waitForPhysicsTicks(bot, 1, signal);
  }
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
  const clock = startEscapeClock(bot, signal, maximumMs);
  const { ended, waits } = clock;
  let walk = newFireWalk(bot, fireEscapeRoute(bot, world, reason));
  let stalled = 0;
  // No search yet from this position: the first loop in lava with an empty walk searches (and finds where to steer).
  const swim: LavaSwim = { searchedAt: "", toward: null, triedSteps: new Set() };
  try {
    if (reason === "lethal_burn" && walk.route.length === 0 && bucketAvailable(bot))
      walk = await pourBurnRefuge(bot, world, waits);
    while (bot.health > 0 && !ended.aborted) {
      signal.throwIfAborted();
      const inLava = isInLava(bot);
      const inFire = isInFire(bot);
      const safeFooting = isOnSafeFooting(bot, inLava, inFire);
      if (hasNothingLeftToEscape(bot, safeFooting)) return "escaped";
      // Retain the departure through a jump: above lava is not a landing (2026-11-07).
      const hop = walk.route[walk.next];
      if (hop && !clearFireEscape(bot, world, hop, walk.departure)) walk = newFireWalk(bot, fireEscapeRoute(bot, world, reason));
      // There is no water in the Nether. Solid terrain can still replace a
      // lava cell and provide the bank the local swimming controller needs.
      if (walk.route.length === 0 && inLava) walk = await wayOutOfLava(bot, world, reason, waits, swim);
      if (walk.route.length === 0 && inFire) {
        // Environmental authority permits extinguishing occupied fire in a sealed refuge (2026-11-07).
        for (const cell of fireContactCells(bot)) await extinguishFireAt(bot, cell, waits, true);
        if (!isInFire(bot)) continue;
      }
      if (reason !== "lethal_burn" && safeFooting && bot.entity.onGround && !routeEndsInWater(world, walk.route)) return "escaped";
      const target = walk.route[walk.next];
      if (!target && inLava) {
        // No bank, no step: swim up (a pool two deep ends at its surface row, where a bank or a step is in reach).
        stalled = 0;
        swimUpInLava(bot, swim.toward);
        await waitForPhysicsTicks(bot, 1, waits);
        continue;
      }
      if (!target) return "blocked";
      const distance = bot.entity.position.distanceTo(target);
      if (distance < walk.best - 0.05) {
        walk = { ...walk, best: distance };
        stalled = 0;
      } else stalled++;
      // Two seconds without closing distance detects an obstructed jump out
      // of liquid. Release with evidence rather than retain a dead steering loop.
      if (stalled >= 40) {
        if (!inLava) return "blocked";
        // In lava a stalled hop is not the end (a wall on the way to the bank): ask for a lava step once, then the loop
        // goes on (the route is searched again, the step is not asked twice) until the 15 s wall clock.
        const step = await buildLavaEscapeStep(bot, world, waits, swim.triedSteps);
        walk = newFireWalk(bot, step && [step]);
        stalled = 0;
        continue;
      }
      steerToward(bot, target);
      await waitForPhysicsTicks(bot, 1, waits);
      if (distance < 0.4 && bot.entity.onGround && !Reflect.get(bot.entity, "isInWater"))
        walk = arriveAtCell(bot, world, reason, walk);
    }
    signal.throwIfAborted();
    return clock.outcome();
  } catch (error) {
    signal.throwIfAborted();
    if (!ended.aborted) throw error;
    return clock.outcome();
  } finally {
    clock.release();
    bot.clearControlStates();
  }
}
