import type { Position3 } from "../../utils/index.js";
import { physicsTicksUntil } from "../../utils/physics-ticks.js";
import { timeoutSignal } from "../../utils/wall-timers.js";
import { holdSwimDepth, solidFloorUnder } from "../world/swimming.js";
import type { BlockPosition, WorldView } from "../world/world.js";
import { horizontalControlsToward, type HorizontalSteeringControl } from "./local-steering.js";

interface WaterPositionBot {
  readonly entity: { readonly position: Position3; readonly velocity?: Position3; readonly onGround?: boolean; readonly yaw?: number; readonly isInWater?: boolean };
  on(event: "physicsTick", listener: () => void): unknown;
  off(event: "physicsTick", listener: () => void): unknown;
  setControlState(control: HorizontalSteeringControl | "jump", active: boolean): void;
}

/**
 * The cell a dig was planned from and how to read the world: while that cell has a solid floor (`solidFloorUnder`, the
 * planner's rule for pricing the dig as standing), the hold lets the body sink onto it instead of holding its depth.
 */
export interface StanceFloor {
  readonly stance: BlockPosition;
  readonly read: WorldView["blockAt"];
}

/** The floor of the stance at `feet` for a hold there, or undefined when the cell below is not a solid floor. */
export function stanceFloorAt(read: WorldView["blockAt"], feet: BlockPosition): StanceFloor | undefined {
  return solidFloorUnder(read, feet) ? { stance: { x: feet.x, y: feet.y, z: feet.z }, read } : undefined;
}

/**
 * How long a body let down onto its stance floor is waited for (`landOnStanceFloor`): 0.38 blocks of water sink in
 * about 8 ticks (lava-interrupts-mining's escape cell), so 40 ticks is five times that, and 3 s of wall clock ends the
 * wait when ticks come slowly. It runs inside a break's confirmation deadline, at least max(5 s, 2 x the longest dig),
 * which for a body in water is x25 the dry dig (obsidian with a diamond pickaxe: 9.4 s x25 = 235 s), so 3 s fits.
 */
export const STANCE_LANDING_TICKS = 40;
export const STANCE_LANDING_WALL_MS = 3_000;

/**
 * Wait for a body in water to land on its stance's solid floor, which `holdWaterPosition` with that `floor` lets it
 * sink onto: Minecraft digs x5 slower off the ground. Answers whether it is on the ground; false at once when it is
 * dry or the stance has no floor, and when the wait ran out (a dig then goes ahead from where the body is). An abort
 * rejects with the signal's reason.
 */
export async function landOnStanceFloor(
  bot: WaterPositionBot,
  floor: StanceFloor,
  signal: AbortSignal,
  bounds: { readonly ticks: number; readonly wallMs: number } = { ticks: STANCE_LANDING_TICKS, wallMs: STANCE_LANDING_WALL_MS },
): Promise<boolean> {
  if (bot.entity.onGround) return true;
  if (!bot.entity.isInWater || !solidFloorUnder(floor.read, floor.stance)) return false;
  const deadline = timeoutSignal(bounds.wallMs);
  try {
    return await physicsTicksUntil(bot, () => bot.entity.onGround === true, bounds.ticks, AbortSignal.any([signal, deadline]));
  } catch (cause) {
    if (signal.aborted || !deadline.aborted) throw cause;
    return false;
  }
}

/**
 * Let a body in water down onto its working cell `feet` before a dig from it: Minecraft digs x5 slower off the ground.
 * Over a solid floor (`solidFloorUnder`, the planner's rule for pricing a dig as standing) the hold lets it sink and
 * the wait is bounded (`landOnStanceFloor`); a body that has not landed then digs anyway when its eyes are dry, the x5
 * it was always going to pay. With the eyes under water (x5 again) and no floor reached in 60 ticks, answers false: no
 * dig. True at once on the ground, and for a dry-eyed body with no floor under it.
 */
export async function settleInWaterForDig(
  bot: WaterPositionBot,
  read: WorldView["blockAt"],
  feet: BlockPosition,
  eyesInWater: boolean,
  signal?: AbortSignal,
): Promise<boolean> {
  // Read through a call: physics moves the body between the reads, which a narrowed property would hide.
  const landed = () => bot.entity.onGround === true;
  if (landed()) return true;
  const floor = stanceFloorAt(read, feet);
  if (!eyesInWater && (floor === undefined || bot.entity.isInWater !== true)) return true;
  const release = holdWaterPosition(bot, signal, (control, active) =>
    bot.setControlState(control, control === "jump" ? false : active), floor);
  const lifetime = signal ?? new AbortController().signal;
  try {
    // Eyes under water keep the 60 ticks a body sinking a whole cell may need (2 x the 3 s bound on the wall clock).
    if (floor) await landOnStanceFloor(bot, floor, lifetime, eyesInWater ? { ticks: 60, wallMs: 2 * STANCE_LANDING_WALL_MS } : undefined);
    else await physicsTicksUntil(bot, landed, 60, lifetime);
  } finally {
    release();
  }
  return landed() || !eyesInWater;
}

/** How many water stances each bot holds right now: the stance steers the body (it keeps its own depth), so nothing else may. */
const stancesHeld = new WeakMap<object, number>();

/** Water stances `bot` holds at this moment (see {@link holdWaterPosition}). */
export function waterStancesHeld(bot: object): number {
  return stancesHeld.get(bot) ?? 0;
}

/**
 * Hold a stationary interaction against a current without changing its aim. It counts as held (see {@link waterStancesHeld})
 * until released or aborted. With `floor`, a body above the planned stance's solid floor is let down onto it (the floor
 * is read each tick: one broken under the body falls back to the start depth); otherwise it keeps the depth it had.
 */
export function holdWaterPosition(
  bot: WaterPositionBot,
  signal: AbortSignal | undefined,
  setControl: (control: HorizontalSteeringControl | "jump", active: boolean) => void = (control, active) =>
    bot.setControlState(control, active),
  floor?: StanceFloor,
): () => void {
  const standing = { ...bot.entity.position };
  const controls = ["forward", "back", "left", "right"] as const;
  const hold = () => {
    const correction = horizontalControlsToward(
      { position: bot.entity.position, yaw: bot.entity.yaw ?? 0 },
      standing,
      0.05,
    );
    for (const control of controls)
      setControl(control, !signal?.aborted && bot.entity.isInWater === true && correction[control]);
    // Supported mining must stay on its floor: jumping multiplies dig time again.
    const onFloor = floor !== undefined && solidFloorUnder(floor.read, floor.stance);
    if (bot.entity.isInWater) setControl("jump", !signal?.aborted && !bot.entity.onGround && !onFloor &&
      holdSwimDepth(bot.entity.position.y, bot.entity.velocity?.y ?? 0, standing.y));
  };
  const letGoOfControls = () => {
    for (const control of controls) setControl(control, false);
    setControl("jump", false);
  };
  let counted = signal?.aborted !== true;
  const leaveStance = () => {
    bot.off("physicsTick", hold);
    if (!counted) return;
    counted = false;
    stancesHeld.set(bot, waterStancesHeld(bot) - 1);
  };
  // An aborted stance has lost the body to whoever aborted it (a reflex): it stops counting and steering at once and
  // writes no control after that, instead of writing on every tick until its owner releases it (the release clears them).
  if (counted) {
    stancesHeld.set(bot, waterStancesHeld(bot) + 1);
    bot.on("physicsTick", hold);
  }
  signal?.addEventListener("abort", leaveStance, { once: true });
  return () => {
    signal?.removeEventListener("abort", leaveStance);
    leaveStance();
    letGoOfControls();
  };
}
