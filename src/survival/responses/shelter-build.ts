// What a hide in progress shares between its steps (the build), and the steps that act on the bot: hold, centre, place, strike.
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { centerOnCell, steeringPortFor, type NavigationRuntime } from "../../navigation/index.js";
import { monotonicNow } from "../../utils/index.js";
import { cellIntersectsBody } from "../../utils/geometry.js";
import { waitForPhysicsTicks } from "../../utils/physics-ticks.js";
import type { ResponseContext } from "../control/combat/context.js";
import { serverPacedWallMs } from "../../world/world-age.js";
import { serverTickPace } from "../../world/server-tick-pace.js";
import { isInLava, isInWater } from "../perception/body.js";
import { isThreat } from "../perception/combat/threats.js";
import { buildProtection, fullProtectionBlock } from "../positioning/combat/build-protection.js";
import { countCapBlocks } from "../positioning/combat/hide-blocks.js";
import { protectionShell } from "../positioning/combat/planner.js";
import { occupiedCell } from "../../world/placement.js";
import { equipCombatLoadout, permittedMeleeLoadout } from "../weapons/equipment.js";
import type { CombatItemUse } from "../weapons/item-use.js";
import { canMeleeTarget, combatItemsForTarget, hasSweepBystander, sweepsOnSwing } from "../weapons/melee.js";
import { shieldFacing } from "../weapons/shield-facing.js";
import { attackAndRestart, swingReadiness, type SwingReadiness } from "../weapons/swing-readiness.js";
import type { CoveredRecovery } from "./recover.js";
import { type Entity, shelterFeet, shelterIntruder, shelterIntruders } from "./shelter-cells.js";
import { clearShelterCell } from "./shelter-clearance.js";

export interface HideOptions {
  readonly navigation?: NavigationRuntime;
  readonly signal: AbortSignal;
  readonly threatContext: ResponseContext;
  /** Health at which the hole has done its job and the body is handed back. */
  readonly recoverTo: number;
  readonly maximumMs: number;
  /** Restrict both carried materials and existing cover for destructive hazards. */
  readonly blockNames?: readonly string[];
  /** The response owner can invalidate construction and recovery as its hazard changes. */
  readonly unsafe?: () => string | null;
  /** Healing alone must not hand the body back into an ongoing attack. */
  readonly holdWhile?: () => boolean;
  /** Establish this side first when the caller knows the direction of knockback. */
  readonly firstWallDirection?: Vec3;
}

/** One hide in progress: what the steps share, and the counters its result reports. */
export interface ShelterBuild {
  readonly bot: Bot;
  readonly options: HideOptions;
  readonly itemUse: CombatItemUse;
  /** The bot was already in a closed cell when the hide began. */
  readonly enclosed: boolean;
  /** Monotonic time (`monotonicNow()`) after which a hide that is still building gives up. */
  readonly constructionDeadline: number;
  dug: number;
  walled: number;
  capped: boolean;
  ate: string | null;
  swings: number;
  recovery: CoveredRecovery | null;
  /** Why the first placement that could have closed the box did not, for the record. */
  refusal: string | null;
  pass: number;
  /** Occupied cells in each pass; count is consecutive intruder passes, zero for other bodies. */
  readonly blockedCells: Map<string, { pass: number; count: number; reason: string }>;
}

/** How a construction step leaves the pass: go round again from the top, or stop with this failure. */
export type StepEnd = "again" | StepFailure;

/** A step that ends the hide: the result's `failed` conclusion. */
export interface StepFailure {
  readonly kind: "failed";
  readonly error: string;
}

export function shelterBlocks(build: ShelterBuild): number {
  return countCapBlocks(build.bot, build.options.blockNames);
}

export function shelterHazard(build: ShelterBuild): string | null {
  return build.options.unsafe?.() ?? null;
}

/**
 * The shell cells a pass recorded as blocked and that are occupied now, `<x,y,z> (<occupant>)` joined by `; `, or "". The
 * shell is the four sides at feet and head height and the cap, around the bot's current feet. Evaluated when a failure is
 * written, from any pass's record: a cell its occupant has left, or one outside the shell after the bot moved, is not named.
 */
export function blockedCellsText(build: ShelterBuild): string {
  const { bot } = build;
  const feet = shelterFeet(bot);
  const named = new Map<string, string>();
  // The closed box `shelter-cells.ts` tests: the cap comes out twice for a one-cell passage, the map keeps one entry.
  for (const cell of protectionShell(feet, [feet])) {
    const key = `${cell.x},${cell.y},${cell.z}`;
    const occupant = build.blockedCells.has(key) ? occupiedCell(bot, cell) : null;
    if (occupant) named.set(key, `${key} (${occupant})`);
  }
  return [...named.values()].join("; ");
}

/** Why a hide cannot build in water or lava: it needs ground under the bot, and the model reads what to do. */
export const SHELTER_IN_LIQUID =
  "[SHELTER] The bot is in water or lava: a shelter needs ground. Get out of the liquid first.";

/** The failure that ends a hide begun, or continued, with the body in a liquid; null on dry ground. */
export function shelterLiquidFailure(bot: Bot): StepFailure | null {
  return isInWater(bot) || isInLava(bot) ? { kind: "failed", error: SHELTER_IN_LIQUID } : null;
}

/**
 * What ends a wait of the shelter build besides its ticks: `"construction"` is the construction deadline (a construction
 * step must not outlive the hide); `{ wallDeadline }` is a monotonic time of the wait's own (a guard hold, `holdShelterGuard`),
 * so a guard still waits its ticks late in a hide, after the construction deadline.
 */
export type ShelterWaitBound = "construction" | { readonly wallDeadline: number };

/**
 * Wait `ticks` physics ticks, but never past `bound`: the wall clock ends a physics stream that has stopped (a lagging
 * server), so the pass that follows reaches its own check instead of hanging.
 */
export async function waitForShelterTicks(build: ShelterBuild, ticks: number, bound: ShelterWaitBound): Promise<void> {
  const { bot, options } = build;
  const deadline = bound === "construction" ? build.constructionDeadline : bound.wallDeadline;
  const ended = new AbortController();
  const timer = setTimeout(() => ended.abort(), Math.max(0, deadline - monotonicNow()));
  try {
    await waitForPhysicsTicks(bot, ticks, AbortSignal.any([options.signal, ended.signal]));
  } catch (cause) {
    options.signal.throwIfAborted();
    if (!ended.signal.aborted) throw cause;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Hold the guard for a server-metered duration, or until the shared swing recovers. Keep its own wall backstop even
 * after the construction deadline; death or a departed intruder returns control to the shelter's next pass.
 */
export async function holdShelterGuard(build: ShelterBuild, ticks: number, readiness?: SwingReadiness, wallEnd = Infinity): Promise<void> {
  const { bot, options } = build;
  const pace = serverTickPace(bot), mark = pace.mark();
  const bound = { wallDeadline: Math.min(wallEnd, monotonicNow() + serverPacedWallMs(ticks)) };
  const initialIntruder = shelterIntruder(bot, options.threatContext);
  let completed = false;
  try {
    for (let held = 0; !(readiness?.ready(ticks) ?? pace.ready(mark, ticks, held)); held++) {
      options.signal.throwIfAborted();
      const intruder = shelterIntruder(bot, options.threatContext);
      if (monotonicNow() >= bound.wallDeadline || bot.health <= 0 ||
        (initialIntruder && intruder?.id !== initialIntruder.id)) return;
      if (intruder) await bot.lookAt(shieldFacing(bot, intruder, options.threatContext.resolvedIds), true);
      await waitForShelterTicks(build, 1, bound);
    }
    completed = true;
  } finally {
    // A successor must finish shield startup after an interrupted hold (a11 T3b review, 2026-11-17).
    if (!readiness && !completed) build.itemUse.invalidateShield();
  }
}

/** Steer the body to the middle of `cell`; false when an intruder in the shell interrupts it. */
export async function centerShelterCell(build: ShelterBuild, cell: Vec3): Promise<boolean> {
  const { bot, options } = build;
  const interrupted = new AbortController();
  const knownIntruders = new Set([...shelterIntruders(bot, options.threatContext)].map((entity) => entity.id));
  const observe = () => {
    for (const intruder of shelterIntruders(bot, options.threatContext)) {
      if (!knownIntruders.has(intruder.id)) {
        interrupted.abort();
        return;
      }
    }
  };
  bot.on("physicsTick", observe);
  try {
    return await centerOnCell(
      {
        ...steeringPortFor(bot, (control, state) => bot.setControlState(control, state)),
        waitForTick: () => waitForShelterTicks(build, 1, "construction"),
      },
      cell,
      AbortSignal.any([options.signal, interrupted.signal]),
    );
  } catch (cause) {
    options.signal.throwIfAborted();
    if (!interrupted.signal.aborted) throw cause;
    return false;
  } finally {
    bot.off("physicsTick", observe);
  }
}

/**
 * Put a carried block into `cell` against any solid neighbour; false when it
 * cannot, never a throw.
 *
 * The first refusal is kept rather than dropped. On 2026-09-04 a hide on
 * ordinary ground placed nothing while carrying forty-seven blocks, and the
 * record said only that nothing could be placed, which names no cause. A
 * cell that is already solid is the box being finished, not a refusal.
 */
export async function sealShelterCell(build: ShelterBuild, cell: Vec3): Promise<boolean> {
  const { bot, options, itemUse } = build;
  const policy = options.threatContext.policy;
  try {
    const existing = bot.blockAt(cell);
    if (fullProtectionBlock(existing) && (!options.blockNames || options.blockNames.includes(existing!.name))) {
      build.blockedCells.delete(`${cell.x},${cell.y},${cell.z}`);
      return false;
    }
    if (!policy.terrain.place) {
      build.refusal ??= "Combat placement prohibited by policy";
      return false;
    }
    const origin = shelterFeet(bot);
    const intruder = shelterIntruder(bot, options.threatContext);
    if (intruder) await repelShelterIntruder(build, intruder);
    if (constructionChanged(build, origin)) return false;
    if (shelterBlocks(build) > 0 && shelterCellOccupied(build, cell)) return false;
    itemUse.lowerShield();
    const built = await buildProtection(bot, [cell], {
      signal: options.signal,
      mayContinue: () => shelterHazard(build),
      terrain: policy.terrain,
      blockNames: options.blockNames,
      clearCell: options.navigation && policy.terrain.dig ? (cell, signal) => clearShelterCell(build, cell, signal) : undefined,
    });
    if (built.kind === "blocked") build.refusal ??= `${cell.x},${cell.y},${cell.z}: ${built.reason}`;
    return built.placed.length > 0;
  } catch (cause) {
    options.signal.throwIfAborted();
    build.refusal ??= `${cell.x},${cell.y},${cell.z}: ${message(cause)}`;
    return false;
  }
}

/** Only intruder occupancy counts toward skipping a cell; other bodies retain the hazard owner's retry path. */
function shelterCellOccupied(build: ShelterBuild, cell: Vec3): boolean {
  const key = `${cell.x},${cell.y},${cell.z}`;
  const reason = occupiedCell(build.bot, cell);
  if (!reason) {
    build.blockedCells.delete(key);
    return false;
  }
  const intruder = [...shelterIntruders(build.bot, build.options.threatContext)]
    .some((entity) => cellIntersectsBody(cell, entity));
  const previous = build.blockedCells.get(key);
  const count = !intruder ? 0
    : previous?.pass === build.pass ? Math.max(1, previous.count) : previous?.pass === build.pass - 1 ? previous.count + 1 : 1;
  build.blockedCells.set(key, { pass: build.pass, count, reason });
  return true;
}

/**
 * Swing at a threat inside the shelter shell, behind the shield when the loadout has one. Every path ends
 * after at least one physics tick: a threat that cannot be struck would otherwise spin the caller's loop
 * in microtasks and starve the event loop (CMB-01).
 */
export async function repelShelterIntruder(build: ShelterBuild, intruder: Entity): Promise<void> {
  const { bot, options, itemUse } = build;
  const { signal, threatContext } = options;
  const policy = threatContext.policy;
  signal.throwIfAborted();
  if (!policy.melee) throw new Error("[COMBAT_CONSTRAINED] Shelter contact defence requires prohibited melee.");
  const loadout = permittedMeleeLoadout(bot, combatItemsForTarget(bot, intruder), policy);
  const readiness = swingReadiness(bot);
  const changedWeapon = bot.heldItem?.name !== loadout.weapon?.name;
  await equipCombatLoadout(bot, loadout);
  signal.throwIfAborted();
  if (changedWeapon || !bot.usingHeldItem) itemUse.invalidateShield();
  if (loadout.shield) await itemUse.raiseShield();
  if (bot.health <= 0 || !isThreat(bot, intruder, threatContext)) return;
  // Preserve the deliberate shield-then-full-cooldown staging (a11 D2, 2026-11-17).
  if (changedWeapon) readiness.restart();
  await holdShelterGuard(build, loadout.cooldownTicks, readiness);
  if (bot.health <= 0 || !readiness.ready(loadout.cooldownTicks)) return;
  await bot.lookAt(intruder.position.offset(0, intruder.height / 2, 0), true);
  signal.throwIfAborted();
  if (
    !isThreat(bot, intruder, threatContext) ||
    shelterIntruder(bot, threatContext)?.id !== intruder.id ||
    !canMeleeTarget(bot, intruder) ||
    (sweepsOnSwing(bot, bot.heldItem) && hasSweepBystander(bot, intruder))
  )
    return waitForShelterTicks(build, 1, { wallDeadline: monotonicNow() + serverPacedWallMs(1) });
  attackAndRestart(bot, intruder);
  build.swings += 1;
  if (loadout.shield) itemUse.activateShield();
  await holdShelterGuard(build, Math.max(1, loadout.cooldownTicks), readiness);
}

/** Whether the construction budget or grounded, centred stance changed. Contact is handled between placements. */
export function constructionChanged(build: ShelterBuild, origin: Vec3): boolean {
  const { bot } = build;
  return (
    monotonicNow() >= build.constructionDeadline ||
    !bot.entity.onGround ||
    !shelterFeet(bot).equals(origin) ||
    (shelterBlocks(build) > 0 &&
      (Math.abs(bot.entity.position.x - origin.x - 0.5) + bot.entity.width / 2 > 0.5 ||
        Math.abs(bot.entity.position.z - origin.z - 0.5) + bot.entity.width / 2 > 0.5))
  );
}



function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
