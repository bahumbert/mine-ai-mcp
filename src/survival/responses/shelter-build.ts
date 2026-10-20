// What a hide in progress shares between its steps (the build), and the steps that act on the bot: hold, centre, place, strike.
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { centerOnCell, steeringPortFor } from "../../navigation/index.js";
import { waitForPhysicsTicks } from "../../utils/physics-ticks.js";
import type { ResponseContext } from "../control/combat/context.js";
import { isInLava, isInWater } from "../perception/body.js";
import { isThreat } from "../perception/combat/threats.js";
import { permittedCombatItems } from "../policy/combat/permissions.js";
import { buildProtection } from "../positioning/combat/build-protection.js";
import { countCapBlocks } from "../positioning/combat/hide-blocks.js";
import { equipCombatLoadout, selectMeleeLoadout } from "../weapons/equipment.js";
import type { CombatItemUse } from "../weapons/item-use.js";
import { canMeleeTarget, combatItemsForTarget, hasSweepBystander } from "../weapons/melee.js";
import { shieldFacing } from "../weapons/shield-facing.js";
import type { CoveredRecovery } from "./recover.js";
import { type Entity, shelterFeet, shelterIntruder } from "./shelter-cells.js";

export interface HideOptions {
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
  /** Wall-clock time (`Date.now()`) after which a hide that is still building gives up. */
  readonly constructionDeadline: number;
  dug: number;
  walled: number;
  capped: boolean;
  ate: string | null;
  swings: number;
  recovery: CoveredRecovery | null;
  /** Why the first placement that could have closed the box did not, for the record. */
  refusal: string | null;
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

/** Why a hide cannot build in water or lava: it needs ground under the bot, and the model reads what to do. */
export const SHELTER_IN_LIQUID =
  "[SHELTER] The bot is in water or lava: a shelter needs ground. Get out of the liquid first.";

/** The failure that ends a hide begun, or continued, with the body in a liquid; null on dry ground. */
export function shelterLiquidFailure(bot: Bot): StepFailure | null {
  return isInWater(bot) || isInLava(bot) ? { kind: "failed", error: SHELTER_IN_LIQUID } : null;
}

/**
 * Wait `ticks` physics ticks, but never past the construction deadline: the
 * wall clock bounds a physics stream that has stopped (a lagging server), so
 * the pass that follows reaches its deadline check instead of hanging.
 */
export async function waitForShelterTicks(build: ShelterBuild, ticks: number): Promise<void> {
  const { bot, options } = build;
  const bound = new AbortController();
  const timer = setTimeout(() => bound.abort(), Math.max(0, build.constructionDeadline - Date.now()));
  try {
    await waitForPhysicsTicks(bot, ticks, AbortSignal.any([options.signal, bound.signal]));
  } catch (cause) {
    options.signal.throwIfAborted();
    if (!bound.signal.aborted) throw cause;
  } finally {
    clearTimeout(timer);
  }
}

/** Wait `ticks` physics ticks, turning the shield toward an intruder in the shelter shell on each. */
export async function holdShelterGuard(build: ShelterBuild, ticks: number): Promise<void> {
  const { bot, options } = build;
  for (let tick = 0; tick < ticks; tick++) {
    options.signal.throwIfAborted();
    const intruder = shelterIntruder(bot, options.threatContext);
    if (intruder) await bot.lookAt(shieldFacing(bot, intruder, options.threatContext.resolvedIds), true);
    await waitForShelterTicks(build, 1);
  }
}

/** Steer the body to the middle of `cell`; false when an intruder in the shell interrupts it. */
export async function centerShelterCell(build: ShelterBuild, cell: Vec3): Promise<boolean> {
  const { bot, options } = build;
  const interrupted = new AbortController();
  const observe = () => {
    if (shelterIntruder(bot, options.threatContext)) interrupted.abort();
  };
  bot.on("physicsTick", observe);
  try {
    return await centerOnCell(
      {
        ...steeringPortFor(bot, (control, state) => bot.setControlState(control, state)),
        waitForTick: () => waitForShelterTicks(build, 1),
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
    if (!policy.terrain.place) {
      build.refusal ??= "Combat placement prohibited by policy";
      return false;
    }
    itemUse.lowerShield();
    const built = await buildProtection(bot, [cell], {
      signal: options.signal,
      mayContinue: () => shelterHazard(build),
      terrain: policy.terrain,
      blockNames: options.blockNames,
    });
    if (built.kind === "blocked") build.refusal ??= `${cell.x},${cell.y},${cell.z}: ${built.reason}`;
    return built.placed.length > 0;
  } catch (cause) {
    options.signal.throwIfAborted();
    build.refusal ??= `${cell.x},${cell.y},${cell.z}: ${message(cause)}`;
    return false;
  }
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
  const loadout = selectMeleeLoadout(permittedCombatItems(combatItemsForTarget(bot, intruder), policy));
  const changedWeapon = bot.heldItem?.name !== loadout.weapon?.name;
  await equipCombatLoadout(bot, loadout);
  signal.throwIfAborted();
  if (changedWeapon || !bot.usingHeldItem) itemUse.invalidateShield();
  if (loadout.shield) await itemUse.raiseShield();
  if (changedWeapon) await holdShelterGuard(build, loadout.cooldownTicks);
  await bot.lookAt(intruder.position.offset(0, intruder.height / 2, 0), true);
  signal.throwIfAborted();
  if (
    !isThreat(bot, intruder, threatContext) ||
    shelterIntruder(bot, threatContext)?.id !== intruder.id ||
    !canMeleeTarget(bot, intruder)
  )
    return holdShelterGuard(build, 1);
  if (bot.heldItem?.name.endsWith("_sword") && hasSweepBystander(bot, intruder)) return holdShelterGuard(build, 1);
  bot.attack(intruder);
  build.swings += 1;
  if (loadout.shield) itemUse.activateShield();
  await holdShelterGuard(build, Math.max(1, loadout.cooldownTicks));
}

/** Whether the body left the cell construction began in, or something entered the shell. */
export function constructionChanged(build: ShelterBuild, origin: Vec3): boolean {
  const { bot, options } = build;
  return (
    !bot.entity.onGround ||
    !shelterFeet(bot).equals(origin) ||
    (shelterBlocks(build) > 0 &&
      (Math.abs(bot.entity.position.x - origin.x - 0.5) + bot.entity.width / 2 > 0.5 ||
        Math.abs(bot.entity.position.z - origin.z - 0.5) + bot.entity.width / 2 > 0.5)) ||
    shelterIntruder(bot, options.threatContext) !== null
  );
}



function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
