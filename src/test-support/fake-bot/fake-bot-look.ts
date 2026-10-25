/**
 * What a look meets, as the server's `getPlayerPOVHitResult` finds it for an item used (boat, bucket): the first solid
 * face and the first fluid top within the block reach of 4.5 blocks (put at 4.40, not at 4.70: contract check
 * `boat-placed-by-use`), the nearer of the two.
 */
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { holdsWater } from "../../navigation/world/deep-water.js";

/** Prismarine's face numbers (`vectorToDirection`): bottom, top, north, south, west, east. */
export const FACE_VECTORS = [new Vec3(0, -1, 0), new Vec3(0, 1, 0), new Vec3(0, 0, -1), new Vec3(0, 0, 1), new Vec3(-1, 0, 0), new Vec3(1, 0, 0)];
/** The block reach. */
export const BLOCK_REACH = 4.5;
/** The look is walked in steps of this length to meet a fluid, then the meeting is narrowed by halving. */
const FLUID_STEP = 0.02;
const FLUID_REFINEMENTS = 12;

/** The fluids a source or flowing block of `level` fills up to, as a fraction of its cell: a source is 8/9. */
function fluidHeight(level: number): number {
  return level >= 8 ? 1 : (8 - level) / 9;
}

/** The look as a direction (a notchian yaw and pitch in degrees, `Entity.getViewVector`). */
export function lookDirection({ x: yaw, y: pitch }: { x: number; y: number }): Vec3 {
  const yawRad = (yaw * Math.PI) / 180;
  const pitchRad = (pitch * Math.PI) / 180;
  return new Vec3(-Math.sin(yawRad) * Math.cos(pitchRad), -Math.sin(pitchRad), Math.cos(yawRad) * Math.cos(pitchRad));
}

/** What a look meets: the point, and the level of the fluid's top when it is a fluid. */
export interface LookMeeting {
  readonly point: Vec3;
  readonly surface: number | null;
}

/**
 * Where a look from `eye` first meets the top of a fluid, or null: the fluid cell's surface level comes with the point.
 * `sourceOnly` meets water sources and no flowing water (vanilla's `ClipContext.Fluid.SOURCE_ONLY`, an empty bucket's look).
 */
function fluidMeeting(bot: Bot, eye: Vec3, direction: Vec3, within: number, sourceOnly: boolean): { point: Vec3; surface: number } | null {
  const surfaceAt = (point: Vec3): number | null => {
    const block = bot.blockAt(point);
    // Water, a water plant or a waterlogged block (`holdsWater`, the runtime's rule; vanilla's `Fluid.ANY`, unmeasured for
    // the plants); lava is not floated on, so a look at it meets nothing here.
    if (block === null || !holdsWater(block.name, block.getProperties())) return null;
    const level = block.name === "water" ? Number(block.getProperties().level ?? 0) : 0;
    if (sourceOnly && (block.name !== "water" || level !== 0)) return null;
    return Math.floor(point.y) + fluidHeight(level);
  };
  const inside = (distance: number) => {
    const point = eye.plus(direction.scaled(distance));
    const surface = surfaceAt(point);
    return surface !== null && point.y < surface ? { point, surface } : null;
  };
  for (let distance = 0; distance <= within; distance += FLUID_STEP) {
    if (inside(distance) === null) continue;
    let [near, far] = [Math.max(0, distance - FLUID_STEP), distance];
    for (let step = 0; step < FLUID_REFINEMENTS; step += 1) {
      const middle = (near + far) / 2;
      if (inside(middle) === null) near = middle;
      else far = middle;
    }
    return inside(far);
  }
  return null;
}

/** What `getPlayerPOVHitResult` finds with fluids counted: the nearer of the first solid face and the first fluid top in reach. */
export function lookMeeting(bot: Bot, eye: Vec3, direction: Vec3, sourceOnly = false): LookMeeting | null {
  const solid = bot.world.raycast(eye, direction, BLOCK_REACH);
  const solidAt = solid === null ? BLOCK_REACH : eye.distanceTo(solid.intersect);
  const fluid = fluidMeeting(bot, eye, direction, solidAt, sourceOnly);
  if (fluid !== null) return fluid;
  return solid === null ? null : { point: solid.intersect, surface: null };
}
