// A fingerprint of placed cells (role, block, states, position), so a regression test and the export script can pin what a house places.
import { createHash } from "node:crypto";
import type { WorldCell } from "./blueprint.ts";

/** The cells as plain records with their keys in a fixed order, absent states left out, sorted by x, then y, then z. */
export function projectCells(cells: readonly WorldCell[]): Record<string, unknown>[] {
  return [...cells]
    .sort((a, b) => a.x - b.x || a.y - b.y || a.z - b.z)
    .map((cell) => ({
      x: cell.x, y: cell.y, z: cell.z, role: cell.role, block: cell.block,
      ...(cell.facing !== undefined && { facing: cell.facing }),
      ...(cell.half !== undefined && { half: cell.half }),
      ...(cell.axis !== undefined && { axis: cell.axis }),
    }));
}

/** The sha256 (hex) of the projected cells: equal for the same house whatever order its cells were listed in. */
export function cellsHash(cells: readonly WorldCell[]): string {
  return createHash("sha256").update(JSON.stringify(projectCells(cells))).digest("hex");
}
