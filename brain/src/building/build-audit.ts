// What the build skill reads from a `build_structure` answer and from the parts built so far (moved out of skills.ts, unchanged).
import { z } from "zod";

export type Cell = { readonly x: number; readonly y: number; readonly z: number };

export function sameCell(left: Cell, right: Cell): boolean {
  return left.x === right.x && left.y === right.y && left.z === right.z;
}

/** The part of `build_structure`'s audit that names the cells it left refused (src/actions/build-structure/contract.ts `left`). */
const refusedAuditSchema = z.object({
  structure: z.object({
    left: z.array(z.object({ reason: z.string(), count: z.number(), named: z.array(z.object({ x: z.number(), y: z.number(), z: z.number(), cause: z.string().optional() })) })),
  }),
});

/**
 * The cells a `build_structure` audit says were refused for good: by policy (named ones only: the runtime names a few
 * per reason). A body in the cell, a route that failed or a placement that did not take may pass on the next try, so
 * they do not count toward giving the house up.
 */
export function refusedCells(result: Readonly<Record<string, unknown>> | undefined): Cell[] {
  const parsed = refusedAuditSchema.safeParse(result);
  if (!parsed.success) return [];
  return parsed.data.structure.left.filter((group) => group.reason === "refused").flatMap((group) => group.named.filter((cell) => cell.cause === "policy").map(({ x, y, z }) => ({ x, y, z })));
}

/** How many cells a `build_structure` audit left, when every one of them was refused (0 when some other reason is in it). */
export function onlyRefused(result: Readonly<Record<string, unknown>> | undefined): number {
  const parsed = refusedAuditSchema.safeParse(result);
  if (!parsed.success || !parsed.data.structure.left.every((group) => group.reason === "refused")) return 0;
  return parsed.data.structure.left.reduce((sum, group) => sum + group.count, 0);
}

/** The non-air cells of the parts before `index`: what a later part's routes must keep. */
export function builtBefore(batches: readonly (readonly { x: number; y: number; z: number; block: string }[])[], index: number, lastPart: ReadonlyMap<string, number>): { x: number; y: number; z: number }[] {
  const seen = new Set<string>();
  const cells: { x: number; y: number; z: number }[] = [];
  for (const cell of batches.slice(0, index).flat()) {
    const key = `${cell.x},${cell.y},${cell.z}`;
    // Only what stays as built: a cell a later part changes again (the doorway) is not kept.
    if (cell.block === "air" || seen.has(key) || (lastPart.get(key) ?? -1) >= index) continue;
    seen.add(key);
    cells.push({ x: cell.x, y: cell.y, z: cell.z });
  }
  return cells;
}
