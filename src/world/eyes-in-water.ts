import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { holdsWater } from "../navigation/world/deep-water.js";

/** The height of the eyes above the feet the dive code has always used. */
const EYE_HEIGHT = 1.62;
/** Minecraft slices a fluid cell in ninths. */
const NINTHS = 9;
/** A source, a falling block and a waterlogged block fill 8 ninths of their cell. */
const FULL_FLUID_AMOUNT = 8;

/** What the rule needs to know of a cell: the block's name and properties (`level`, `waterlogged`). */
export interface WaterCell {
  readonly name: string;
  readonly properties?: Readonly<Record<string, unknown>>;
}
export type WaterCellAt = (x: number, y: number, z: number) => WaterCell | null;

/** How many ninths of its cell the water of this block fills: a source or falling water 8, flowing level 1-7 `8 - level`. */
function fluidAmount(cell: WaterCell): number {
  if (cell.name !== "water") return FULL_FLUID_AMOUNT;
  const level = Number(cell.properties?.level ?? 0);
  return level >= 1 && level < FULL_FLUID_AMOUNT ? FULL_FLUID_AMOUNT - level : FULL_FLUID_AMOUNT;
}

const holdsWaterCell = (cell: WaterCell | null): cell is WaterCell => cell !== null && holdsWater(cell.name, cell.properties);

/**
 * Whether the eyes are under water the way the server decides it (`Entity.updateFluidOnEyes`): the point 1/9 block below
 * the eyes lies in a cell holding water, below that water's top. The top is the cell's ceiling when water lies above it
 * too, else `amount / 9` into the cell. So flowing water of level 4 at eye height does not cover a bot standing on the
 * floor beneath it, and breathing there is what the server counts.
 */
export function eyesInWater(cellAt: WaterCellAt, eyeY: number, x: number, z: number): boolean {
  const point = eyeY - 1 / NINTHS;
  const cellX = Math.floor(x);
  const cellY = Math.floor(point);
  const cellZ = Math.floor(z);
  const cell = cellAt(cellX, cellY, cellZ);
  if (!holdsWaterCell(cell)) return false;
  const top = holdsWaterCell(cellAt(cellX, cellY + 1, cellZ)) ? cellY + 1 : cellY + fluidAmount(cell) / NINTHS;
  return point < top;
}

/** {@link eyesInWater} for the bot's eyes, from `feet` (the bot's own position unless given). */
export function botEyesInWater(bot: Bot, feet: Vec3 = bot.entity.position): boolean {
  return eyesInWater((x, y, z) => {
    const block = bot.blockAt(new Vec3(x, y, z));
    return block && { name: block.name, properties: block.getProperties?.() ?? {} };
  }, feet.y + EYE_HEIGHT, feet.x, feet.z);
}
