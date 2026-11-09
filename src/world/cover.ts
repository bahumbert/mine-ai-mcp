// The shared solid non-leaf rule for cover above a standing cell.
import type { BlockPosition } from "../navigation/index.js";

/** Solid non-leaf cover above the head, as in the brain's shelter/spot.ts underCover (P4-18 extends its read to build height). */
export function coverOver(
  read: (x: number, y: number, z: number) => { solid: boolean; tags: readonly string[] } | null,
  cell: BlockPosition,
  top: number,
): boolean {
  for (let y = cell.y + 2; y <= top; y++) {
    const block = read(cell.x, y, cell.z);
    if (block?.solid && !block.tags.includes("leaves")) return true;
  }
  return false;
}
