// Goal-region geometry and route detour evidence.
import type { GoalRegion, ResolvedGoal } from "../goals/goal.js";
import type { BlockPosition } from "../world/world.js";

/** Return only a region tied to the active predicate with finite straight distances. */
export function searchRegion(goal: Extract<ResolvedGoal, { kind: "active" }>, root: BlockPosition): GoalRegion | null {
  const region = goal.region?.(root);
  return region && region.satisfies === goal.isSatisfied && region.parts.length > 0
    && region.parts.every((part) => Number.isFinite(part.straight)) ? region : null;
}

/** Measure the greatest detour sum for the part nearest the route's endpoint. */
export function routeDetour(region: GoalRegion, root: BlockPosition, cells: readonly BlockPosition[]): { part: number; straight: number; detour: number } {
  const end = cells.at(-1) ?? root;
  let part = 0;
  for (let i = 1; i < region.parts.length; i += 1)
    if (region.parts[i]!.distance(end) < region.parts[part]!.distance(end)) part = i;
  const selected = region.parts[part]!;
  const reach = (cell: BlockPosition) => Math.hypot(cell.x - root.x, cell.y - root.y, cell.z - root.z) + selected.distance(cell);
  let detour = reach(root);
  for (const cell of cells) detour = Math.max(detour, reach(cell));
  return { part, straight: selected.straight, detour };
}
