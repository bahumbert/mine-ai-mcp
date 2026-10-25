/**
 * Deep open water: what a bot crosses by boat, never by swimming (spec 2026-10-04 deep-water-and-boats; owner: never
 * cross deep ocean without a boat at hand, coasts and shallow water are fine).
 *
 * A cell is deep open water when it is water, with water under it for {@link DEEP_WATER_DEPTH} cells in all, and the
 * water runs on at its height for at least {@link OPEN_WATER_SPAN} cells in a row along x and along z through it. A
 * river narrower than that is swum, along or across; a pond shallower than that is waded.
 */

import { OPEN_COLUMN_REACH } from "./swimming.js";
import type { BlockPosition, WorldView } from "./world.js";

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

/**
 * Whether a bot with its feet in this cell is out on deep open water. The sea above counts as much as the sea under
 * the feet: a bot on the sea floor stands in water too shallow to be "deep" by its own cell alone (live 2026-10-10:
 * stranded on the floor, every way up refused as a swim across deep water). So the whole water column over the feet is
 * asked. Already swimming (feet and head in water) under a roof is at sea too: a 1-wide roofed pocket fails the
 * open-water span test (live 2026-10-10), and refusing the sea there leaves no way out. With open air over the water
 * (a river mouth, a shore) it is not: run 7 swam ~130 blocks out to sea that way. A cell not loaded is neither water nor a
 * roof.
 */
export function feetAtSea(read: WorldView["blockAt"], feet: BlockPosition): boolean {
  const water = waterAtOf(read);
  let answer = isDeepOpenWater(water, feet.x, feet.y - 1, feet.z) ||
    (water(feet.x, feet.y, feet.z) && water(feet.x, feet.y + 1, feet.z) && roofedOver(read, water, feet));
  for (let y = feet.y; !answer && water(feet.x, y, feet.z) && y <= feet.y + OPEN_COLUMN_REACH; y++)
    answer = isDeepOpenWater(water, feet.x, y, feet.z);
  return answer || (water(feet.x, feet.y, feet.z) && joinsDeepOpenWater(water, feet));
}

/** A start in water this many water cells (four sides, at the feet's height) from deep open water is at sea too. */
export const SEA_JOIN_REACH = 3;

const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;

/**
 * Whether deep open water lies within {@link SEA_JOIN_REACH} water cells of the feet, through water at their height: a
 * reef or sandbar start ringed by the sea, where refusing every deep cell left the bot stranded (external review
 * NAVP-03; owner 2026-10-19: such a start may swim the deep water). A cell not loaded joins nothing.
 */
function joinsDeepOpenWater(water: WaterAt, feet: BlockPosition): boolean {
  const seen = new Set<string>([`${feet.x},${feet.z}`]);
  let frontier: { x: number; z: number }[] = [{ x: feet.x, z: feet.z }];
  for (let step = 1; step <= SEA_JOIN_REACH && frontier.length > 0; step++) {
    frontier = frontier.flatMap((cell) => waterSidesOf(water, cell, feet.y, seen));
    if (frontier.some((cell) => isDeepOpenWater(water, cell.x, feet.y, cell.z))) return true;
  }
  return false;
}

/** The water cells beside `cell` at height `y` not seen yet, marked seen. */
function waterSidesOf(water: WaterAt, cell: { x: number; z: number }, y: number, seen: Set<string>): { x: number; z: number }[] {
  return SIDES.map(([dx, dz]) => ({ x: cell.x + dx, z: cell.z + dz })).filter((side) => {
    const key = `${side.x},${side.z}`;
    if (seen.has(key) || !water(side.x, y, side.z)) return false;
    seen.add(key);
    return true;
  });
}

/** Whether the water column over the feet ends under something solid; a cell not loaded is no roof. */
function roofedOver(read: WorldView["blockAt"], water: WaterAt, feet: BlockPosition): boolean {
  for (let y = feet.y; y <= feet.y + OPEN_COLUMN_REACH; y++) {
    if (water(feet.x, y, feet.z)) continue;
    const block = read(feet.x, y, feet.z);
    return block.kind === "loaded" && block.collisionShapes.length > 0;
  }
  return false;
}

/** The water test of the deep-water rule over observed cells: liquid water (a water plant's included) or water held in a block. */
export function waterAtOf(read: WorldView["blockAt"]): WaterAt {
  return (x, y, z) => {
    const block = read(x, y, z);
    return block.kind === "loaded" && (block.traits.liquid === "water" || block.traits.waterlogged);
  };
}
