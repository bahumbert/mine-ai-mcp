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
import type { FootingRecovery } from "./footing.js";
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

/** Calls to the shared landing recovery and empty-route ticks, accumulated across one fire claim. */
export interface FireEscapeRecord {
  recovered: number;
  last: "landed" | "failed" | "interrupted" | null;
  airborneTicks: number;
}

/** Optional runtime landing obligation; direct escape callers can omit it. */
export interface FireEscapeOptions {
  maximumMs?: number;
  footing?: Pick<FootingRecovery, "needed" | "recover">;
  record?: FireEscapeRecord;
}

/** Yield steering immediately on renewed fire or lava contact; the escape handles that contact next. */
async function landBeforeFireWalk(bot: Bot, footing: NonNullable<FireEscapeOptions["footing"]>, waits: AbortSignal, record: FireEscapeRecord): Promise<void> {
  const contact = new AbortController();
  const checkContact = () => { if (isInFire(bot) || isInLava(bot)) contact.abort(); };
  bot.on("physicsTick", checkContact);
  record.recovered++;
  try {
    record.last = await footing.recover(AbortSignal.any([waits, contact.signal]));
  } catch (error) {
    record.last = "interrupted";
    waits.throwIfAborted();
    if (!contact.signal.aborted) throw error;
  } finally {
    bot.off("physicsTick", checkContact);
  }
}

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

/** Progress retained between escape ticks, including the departure through an airborne hop. */
interface FireWalkProgress {
  walk: FireWalk;
  stalled: number;
  waitedAirborne: boolean;
  readonly swim: LavaSwim;
}

/** Re-evaluate a route only after the shared landing has relinquished steering. */
async function landFirst(bot: Bot, world: WorldView, reason: FireEscapeReason, waits: AbortSignal, footing: FireEscapeOptions["footing"], record: FireEscapeRecord): Promise<FireWalk | null> {
  if (!footing?.needed || isInLava(bot) || isInFire(bot)) return null;
  await landBeforeFireWalk(bot, footing, waits, record);
  return newFireWalk(bot, fireEscapeRoute(bot, world, reason));
}

/** Advance one escape tick; null retains the claim for another observation. */
async function advanceFireWalk(bot: Bot, world: WorldView, reason: FireEscapeReason, waits: AbortSignal, state: FireWalkProgress, record: FireEscapeRecord): Promise<FireEscapeOutcome | null> {
  if (state.waitedAirborne && bot.entity.onGround) {
    state.walk = newFireWalk(bot, fireEscapeRoute(bot, world, reason));
    state.waitedAirborne = false;
  }
  const inLava = isInLava(bot);
  const inFire = isInFire(bot);
  const safeFooting = isOnSafeFooting(bot, inLava, inFire);
  if (hasNothingLeftToEscape(bot, safeFooting)) return "escaped";
  // Retain the departure through a jump: above lava is not a landing (2026-11-07).
  const hop = state.walk.route[state.walk.next];
  if (hop && !clearFireEscape(bot, world, hop, state.walk.departure)) state.walk = newFireWalk(bot, fireEscapeRoute(bot, world, reason));
  if (state.walk.route.length === 0 && inLava) state.walk = await wayOutOfLava(bot, world, reason, waits, state.swim);
  if (state.walk.route.length === 0 && inFire) {
    // Environmental authority permits extinguishing occupied fire in a sealed refuge (2026-11-07).
    for (const cell of fireContactCells(bot)) await extinguishFireAt(bot, cell, waits, true);
    if (!isInFire(bot)) return null;
  }
  if (reason !== "lethal_burn" && safeFooting && bot.entity.onGround && !routeEndsInWater(world, state.walk.route)) return "escaped";
  const target = state.walk.route[state.walk.next];
  if (!target && inLava) {
    state.stalled = 0;
    swimUpInLava(bot, state.swim.toward);
    await waitForPhysicsTicks(bot, 1, waits);
    return null;
  }
  if (!target && !bot.entity.onGround && !Reflect.get(bot.entity, "isInWater")) {
    record.airborneTicks++;
    state.waitedAirborne = true;
    await waitForPhysicsTicks(bot, 1, waits);
    return null;
  }
  if (!target) return "blocked";
  const distance = bot.entity.position.distanceTo(target);
  if (distance < state.walk.best - 0.05) {
    state.walk = { ...state.walk, best: distance };
    state.stalled = 0;
  } else state.stalled++;
  // Two seconds without closing distance detects an obstructed jump out of liquid (legacy, P4-35).
  if (state.stalled >= 40) {
    if (!inLava) return "blocked";
    const step = await buildLavaEscapeStep(bot, world, waits, state.swim.triedSteps);
    state.walk = newFireWalk(bot, step && [step]);
    state.stalled = 0;
    return null;
  }
  steerToward(bot, target);
  await waitForPhysicsTicks(bot, 1, waits);
  if (distance < 0.4 && bot.entity.onGround && !Reflect.get(bot.entity, "isInWater"))
    state.walk = arriveAtCell(bot, world, reason, state.walk);
  return null;
}

/** Leave the active source; residual burning must not monopolise the body without reachable water. */
export async function escapeFire(
  bot: Bot,
  world: WorldView,
  signal: AbortSignal,
  reason: FireEscapeReason = "contact",
  { maximumMs = FIRE_ESCAPE_MAXIMUM_MS, footing, record = { recovered: 0, last: null, airborneTicks: 0 } }: FireEscapeOptions = {},
): Promise<FireEscapeOutcome> {
  bot.stopDigging();
  bot.deactivateItem();
  bot.clearControlStates();
  const clock = startEscapeClock(bot, signal, maximumMs);
  const { ended, waits } = clock;
  const state: FireWalkProgress = {
    walk: newFireWalk(bot, fireEscapeRoute(bot, world, reason)), stalled: 0, waitedAirborne: false,
    swim: { searchedAt: "", toward: null, triedSteps: new Set() },
  };
  try {
    state.walk = await landFirst(bot, world, reason, waits, footing, record) ?? state.walk;
    if (reason === "lethal_burn" && state.walk.route.length === 0 && bucketAvailable(bot))
      state.walk = await pourBurnRefuge(bot, world, waits);
    while (bot.health > 0 && !ended.aborted) {
      signal.throwIfAborted();
      state.walk = await landFirst(bot, world, reason, waits, footing, record) ?? state.walk;
      const outcome = await advanceFireWalk(bot, world, reason, waits, state, record);
      if (outcome) return outcome;
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
