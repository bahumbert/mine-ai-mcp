import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { holdsWater } from "../navigation/world/deep-water.js";
import { STANDING_EYE_HEIGHT } from "./block-visibility.js";

/** Minecraft slices a fluid cell in ninths. */
const NINTHS = 9;
/** A source, a falling block and a waterlogged block fill 8 ninths of their cell. */
const FULL_FLUID_AMOUNT = 8;
/** Vanilla 1.21.4 Pose ids and the crouching eye height reported by Mineflayer's entities plugin. */
const STANDING_POSE = 0;
const CROUCHING_POSE = 5;
const CROUCHING_EYE_HEIGHT = 1.27;
const MEASURED_VERSION = "1.21.4";

/** What the rule needs to know of a cell: the block's name and properties (`level`, `waterlogged`). */
export interface WaterCell {
  readonly name: string;
  readonly properties?: Readonly<Record<string, unknown>>;
}
export type WaterCellAt = (x: number, y: number, z: number) => WaterCell | null;
type EyeSample = "vanilla" | "legacy" | "legacy-fake";

/**
 * How many ninths of its cell the water of this block fills: a source, falling water, a plant or a waterlogged block 8,
 * flowing level 1-7 `8 - level`. Only the water block's own `level` is a flow level: a waterloggable block's (a light
 * block's) is not.
 */
function fluidAmount(cell: WaterCell, sample: EyeSample): number {
  const properties = cell.properties ?? {};
  const level = Number(properties.level ?? 0);
  // The old fake interpreted a waterlogged block's own level and kept the caller's eye height.
  if (sample === "legacy-fake") return level === 0 || level >= FULL_FLUID_AMOUNT ? FULL_FLUID_AMOUNT : FULL_FLUID_AMOUNT - level;
  if ("waterlogged" in properties) return FULL_FLUID_AMOUNT;
  return level >= 1 && level < FULL_FLUID_AMOUNT ? FULL_FLUID_AMOUNT - level : FULL_FLUID_AMOUNT;
}

const holdsWaterCell = (cell: WaterCell | null): cell is WaterCell => cell !== null && holdsWater(cell.name, cell.properties);

/** Compare the sample with the surface in its own cell. Vanilla adds the height to Y in float precision. */
function eyeInFluid(cellAt: WaterCellAt, point: number, x: number, z: number, sample: EyeSample): boolean {
  const cellX = Math.floor(x);
  const cellY = Math.floor(point);
  const cellZ = Math.floor(z);
  const cell = cellAt(cellX, cellY, cellZ);
  if (!holdsWaterCell(cell)) return false;
  const height = holdsWaterCell(cellAt(cellX, cellY + 1, cellZ)) ? 1 : fluidAmount(cell, sample) / NINTHS;
  const top = sample === "vanilla" ? Math.fround(cellY + Math.fround(height)) : cellY + height;
  return point < top;
}

/** The actual eye point and strict surface comparison of 1.21.4 `Entity.updateFluidOnEyes` (`bum.G`, 2026-11-20). */
export function eyesInWater(cellAt: WaterCellAt, eyeY: number, x: number, z: number): boolean {
  return eyeInFluid(cellAt, eyeY, x, z, "vanilla");
}

/** The measured eye rule requires this registry's pose field as well as the qualified version. */
function eyePoseIndex(bot: Bot): number {
  if (bot.registry?.version.minecraftVersion !== MEASURED_VERSION) return -1;
  // Vanilla scales the pose's dimensions, including the eye height. Mineflayer reports scale separately.
  const attributes = (bot.entity as { attributes?: Record<string, { value: number; modifiers: readonly unknown[] } | undefined> }).attributes;
  const scale = attributes?.["generic.scale"];
  if (scale !== undefined && (scale.value !== 1 || scale.modifiers?.length !== 0)) return -1;
  return bot.registry.entitiesByName.player?.metadataKeys?.indexOf("pose") ?? -1;
}

/** Accept only the standing or crouching eye height which the client has filed for this body. */
function qualifiedEyeHeight(bot: Bot): number | null {
  const index = eyePoseIndex(bot);
  if (index < 0 || Reflect.get(bot, "vehicle") != null) return null;
  const pose: unknown = bot.entity.metadata?.[index];
  const height: unknown = Reflect.get(bot.entity, "eyeHeight");
  if (pose === CROUCHING_POSE && height === CROUCHING_EYE_HEIGHT) return height;
  // Vanilla omits pose metadata while it has the default standing value.
  if ((pose === undefined || pose === STANDING_POSE) && height === STANDING_EYE_HEIGHT) return height;
  return null;
}

/** Whether the current body qualifies for the measured eye rule. */
export function hasQualifiedEyeWaterSample(bot: Bot): boolean {
  return qualifiedEyeHeight(bot) !== null;
}

/** An unqualified sample keeps the old offset and the caller's previous height. */
function sampleBotEyes(bot: Bot, feet: Vec3, height: number | null, legacyEyeHeight?: number): boolean {
  const at: WaterCellAt = (x, y, z) => {
    const block = bot.blockAt(new Vec3(x, y, z));
    return block && { name: block.name, properties: block.getProperties?.() ?? {} };
  };
  if (height !== null) return eyesInWater(at, feet.y + Math.fround(height), feet.x, feet.z);
  if (legacyEyeHeight !== undefined) return eyeInFluid(at, feet.y + (legacyEyeHeight - 1 / NINTHS), feet.x, feet.z, "legacy-fake");
  return eyeInFluid(at, feet.y + STANDING_EYE_HEIGHT - 1 / NINTHS, feet.x, feet.z, "legacy");
}

/** Sample the live body's pose at its feet, or at the authoritative feet of that same body in a contract probe. */
export function botEyesInWater(bot: Bot, feet: Vec3 = bot.entity.position, legacyEyeHeight?: number): boolean {
  return sampleBotEyes(bot, feet, qualifiedEyeHeight(bot), legacyEyeHeight);
}

/** Sample an unmounted standing destination without borrowing the live body's pose. */
export function standingEyesInWater(bot: Bot, feet: Vec3): boolean {
  return sampleBotEyes(bot, feet, eyePoseIndex(bot) < 0 ? null : STANDING_EYE_HEIGHT);
}
