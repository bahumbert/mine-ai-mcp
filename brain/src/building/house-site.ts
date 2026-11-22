// Where a house goes: the box it protects, the box its site touches, and the nearest clear site when a protected area is in
// the way (moved out of skills.ts, unchanged; also used by farm plots through `nearestClearSpot`).
import { isCanopy } from "../block-kinds.ts";
import { areaKey, type BotRuntime, type Position, type ProtectedArea } from "../runtime-client.ts";
import { overlapsOf } from "../protected-areas.ts";
import { planTemplate, siteAt, type HousePlan, type Site } from "./plan.ts";
import { levelBox } from "./terrain.ts";
import type { Template } from "./templates.ts";

/**
 * A house's protected box: its cells, a one-block ring around them and the layer under them, so gathering beside it
 * cannot undermine a wall or take the doorstep (live 2026-10-01: dirt dug under Tom's doorway).
 */
export function houseBox(cells: readonly Position[]): { readonly min: Position; readonly max: Position } {
  const xs = cells.map((cell) => cell.x);
  const ys = cells.map((cell) => cell.y);
  const zs = cells.map((cell) => cell.z);
  return {
    min: { x: Math.min(...xs) - 1, y: Math.min(...ys) - 1, z: Math.min(...zs) - 1 },
    max: { x: Math.max(...xs) + 1, y: Math.max(...ys), z: Math.max(...zs) + 1 },
  };
}

/** How far around a refused house site the nearest clear one is looked for. */
export const SITE_SEARCH = 32;

/** Everything a new house touches: its protected box and the box its site leveling digs and fills. */
export function siteBox(plan: HousePlan): { readonly min: Position; readonly max: Position } {
  const house = houseBox(plan.batches.flat());
  const level = levelBox({ minX: house.min.x, maxX: house.max.x, minZ: house.min.z, maxZ: house.max.z }, plan.site.door.y);
  return {
    min: { x: house.min.x, y: Math.min(house.min.y, level.min.y), z: house.min.z },
    max: { x: house.max.x, y: Math.max(house.max.y, level.max.y), z: house.max.z },
  };
}

/**
 * The door of the nearest house site, at the same height, whose house and leveling overlap no protected area, as
 * `build` at those coordinates would plan it (facing whoever it is for); null when none lies within
 * {@link SITE_SEARCH} blocks. Geometry only: the ground there is leveled by the build as usual.
 */
export function nearestClearSite(areas: readonly ProtectedArea[], template: Template, refused: Site, toward: Position | null): Position | null {
  // One plan per facing, then moved: the box of a door elsewhere is the same box shifted.
  const boxes = new Map<string, { readonly min: Position; readonly max: Position }>();
  const boxFor = (door: Position) => {
    const facing = siteAt(door, toward).facing;
    let box = boxes.get(facing);
    if (box === undefined) {
      box = siteBox(planTemplate(template, { door: refused.door, facing }));
      boxes.set(facing, box);
    }
    const [dx, dz] = [door.x - refused.door.x, door.z - refused.door.z];
    return { min: { x: box.min.x + dx, y: box.min.y, z: box.min.z + dz }, max: { x: box.max.x + dx, y: box.max.y, z: box.max.z + dz } };
  };
  return nearestClearSpot(areas, refused.door, boxFor);
}

/** How far above and below a suggested site the ground of its column is looked for. */
const GROUND_SEARCH = 16;

/**
 * `door` moved to the walking level of its column: the feet cell over the highest solid block (canopy is not ground)
 * within {@link GROUND_SEARCH} of its height, as the walk to the site needs a cell to stand on (live 2026-10-11: a
 * door suggested at 70 over ground at 66, and the `go to` there failed NAVIGATION_TARGET_UNSUPPORTED). Unchanged when
 * the column shows no ground in that range.
 */
export async function groundedDoor(runtime: BotRuntime, door: Position): Promise<Position> {
  const area = await runtime.blocksIn({ x: door.x, y: door.y - GROUND_SEARCH, z: door.z }, { x: door.x, y: door.y + GROUND_SEARCH, z: door.z });
  const solid = (y: number) => {
    const block = area.blocks.get(areaKey(door.x, y, door.z));
    return block !== undefined && area.kinds[block]?.solid === true && !isCanopy(area.kinds[block]);
  };
  for (let y = door.y + GROUND_SEARCH; y >= door.y - GROUND_SEARCH; y -= 1) {
    if (solid(y)) return { ...door, y: y + 1 };
  }
  return door;
}

/**
 * The spot nearest `origin`, at its height, whose box (`boxAt`) overlaps no protected area, within {@link SITE_SEARCH}
 * blocks; null when none. Shared by houses (their door) and farm plots (their middle).
 */
export function nearestClearSpot(areas: readonly ProtectedArea[], origin: Position, boxAt: (spot: Position) => { readonly min: Position; readonly max: Position }): Position | null {
  for (let ring = 1; ring <= SITE_SEARCH; ring += 1) {
    const clear = spotsOnRing(origin, ring).find((spot) => overlapsOf(areas, boxAt(spot)).length === 0);
    if (clear !== undefined) return clear;
  }
  return null;
}

/** The spots exactly `ring` blocks (in the larger axis) from `origin`, at its height, the nearest first. */
function spotsOnRing(origin: Position, ring: number): Position[] {
  const spots: Position[] = [];
  for (let dx = -ring; dx <= ring; dx += 1) {
    for (let dz = -ring; dz <= ring; dz += 1) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) === ring) spots.push({ x: origin.x + dx, y: origin.y, z: origin.z + dz });
    }
  }
  return spots.sort((a, b) => Math.hypot(a.x - origin.x, a.z - origin.z) - Math.hypot(b.x - origin.x, b.z - origin.z));
}
