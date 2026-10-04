/**
 * Deep open water: what a bot crosses by boat, never by swimming (spec 2026-10-04 deep-water-and-boats; owner: never
 * cross deep ocean without a boat at hand, coasts and shallow water are fine).
 *
 * A cell is deep open water when it is water, with water under it for {@link DEEP_WATER_DEPTH} cells in all, and the
 * water runs on at its height for at least {@link OPEN_WATER_SPAN} cells in a row along x and along z through it. A
 * river narrower than that is swum, along or across; a pond shallower than that is waded.
 */

/** The cell and the two below it: deeper than a bot can stand up in. */
export const DEEP_WATER_DEPTH = 3;
/** More than eight blocks of water in a row: a short swim is fine, an ocean or a wide lake is not. */
export const OPEN_WATER_SPAN = 9;

/** Plants and columns that only stand in water: the sea's water as much as a water block (live 2026-10-04: kelp at the
 * surface read as dry ground stopped a boat ride after two blocks). */
export const WATER_ONLY_BLOCKS: ReadonlySet<string> = new Set(["kelp", "kelp_plant", "seagrass", "tall_seagrass", "bubble_column"]);

/** Whether a block of this name and these properties holds water: water, a water plant, or anything waterlogged. */
export function holdsWater(name: string, properties: Readonly<Record<string, unknown>> = {}): boolean {
  return name === "water" || WATER_ONLY_BLOCKS.has(name) || properties.waterlogged === true || properties.waterlogged === "true";
}

/** Whether this cell holds water; an unloaded cell is not water. */
export type WaterAt = (x: number, y: number, z: number) => boolean;

export function isDeepOpenWater(waterAt: WaterAt, x: number, y: number, z: number): boolean {
  for (let depth = 0; depth < DEEP_WATER_DEPTH; depth += 1) if (!waterAt(x, y - depth, z)) return false;
  return waterRun(waterAt, x, y, z, 1, 0) >= OPEN_WATER_SPAN && waterRun(waterAt, x, y, z, 0, 1) >= OPEN_WATER_SPAN;
}

/** Water cells in a row through (x, y, z) along one axis, counted up to {@link OPEN_WATER_SPAN}. */
function waterRun(waterAt: WaterAt, x: number, y: number, z: number, dx: number, dz: number): number {
  let run = 1;
  for (const sign of [1, -1]) {
    for (let step = 1; run < OPEN_WATER_SPAN && waterAt(x + dx * step * sign, y, z + dz * step * sign); step += 1) run += 1;
  }
  return run;
}
