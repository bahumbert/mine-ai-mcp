import type { BlockObservation, BlockPosition, WorldView } from "./world.js";
import { isHeadPassable, isSafeSupport } from "./block-geometry.js";
import { OPEN_COLUMN_REACH, openWaterSurface } from "./swimming.js";

/**
 * Whether nothing solid roofs the column above this cell within the reach a swimmer climbs (water and air both let a
 * swimmer through). A puddle in a sealed pocket has a roof; a pond or the sea has none. A cell the world does not
 * show ends the scan: the column is then open as far as it is known.
 */
function roofless(read: WorldView["blockAt"], x: number, y: number, z: number): boolean {
  for (let above = y; above <= y + OPEN_COLUMN_REACH; above++) {
    const block = read(x, above, z);
    if (block.kind !== "loaded") return true;
    if (block.collisionShapes.length > 0) return false;
  }
  return true;
}

/**
 * Existing still-water work, never permission to flood a dry mining stance. A puddle the bot stands in only counts
 * when the water is open to the air above it: sealing in a roofed pocket by letting the sea in behind a wall is the
 * flood this rule exists to prevent (live 2026-10-10: a dug pocket with a puddle on its floor, then the sea).
 */
export function waterMiningStance(read: WorldView["blockAt"], feet: BlockPosition, supported: boolean): boolean {
  const body = read(feet.x, feet.y, feet.z);
  if (body.kind !== "loaded" || body.traits.liquid !== "water" || !body.traits.liquidSource ||
    body.collisionShapes.length > 0) return false;
  const head = read(feet.x, feet.y + 1, feet.z);
  if (head.kind !== "loaded") return false;
  if (head.traits.liquid === null && isHeadPassable(head)) return roofless(read, feet.x, feet.y + 2, feet.z);
  // Submerged work additionally passes the runtime's live dive/air admission.
  return supported && openWaterSurface(read, feet) !== null;
}

export type WaterOccupancy = "surface" | "shallow_submerged" | "submerged" | "unavailable";

/** Body geometry only; submerged travel additionally needs a scoped air/escape budget. */
export function waterOccupancy(
  read: (x: number, y: number, z: number) => BlockObservation,
  x: number,
  y: number,
  z: number,
): WaterOccupancy {
  const feet = read(x, y, z);
  if (feet.kind !== "loaded" || feet.traits.liquid !== "water") return "unavailable";
  const head = read(x, y + 1, z);
  if (head.kind !== "loaded") return "unavailable";
  const below = read(x, y - 1, z);
  const floor = isSafeSupport(below);
  const dryHead = head.traits.liquid === null && isHeadPassable(head);
  if (dryHead) {
    // Still-water surfaces can float over depth. A flowing surface needs the
    // nearby floor used by wading and by an exit from a mined pickup hole.
    const shallow =
      floor || (below.kind === "loaded" && below.traits.liquid === "water" && isSafeSupport(read(x, y - 2, z)));
    return feet.traits.liquidSource || shallow ? "surface" : "unavailable";
  }
  const above = read(x, y + 2, z);
  return floor &&
    head.traits.liquid === "water" &&
    above.kind === "loaded" &&
    above.traits.liquid === null &&
    isHeadPassable(above)
    ? "shallow_submerged"
    : (feet.traits.liquidSource || floor) && head.traits.liquid === "water" && head.traits.liquidSource &&
        feet.collisionShapes.length === 0 && head.collisionShapes.length === 0 ? "submerged" : "unavailable";
}
