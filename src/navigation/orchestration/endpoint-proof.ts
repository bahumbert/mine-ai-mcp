// The conditions under which the world and a goal expose a bounded set of route endpoints.
import type { ResolvedGoal } from "../goals/goal.js";
import type { MovementPolicy } from "../movements/policy.js";
import { GEOMETRY_FULL_CUBE, isDry, navigationFeet } from "../world/block-geometry.js";
import type { BlockObservation, BlockPosition, NavigationObservation, WorldView } from "../world/world.js";

/** A range-three near goal's enclosing cube, before filtering by distance. */
export const MAX_PROOF_CUBE = 343;

/** The possible endpoints for an admission's proof, or null when the normal search must decide. */
export function provenEndpoints({ goal, observation, policy, world, hasCalculationFallback }: {
  readonly goal: Extract<ResolvedGoal, { kind: "active" }>;
  readonly observation: NavigationObservation;
  readonly policy: MovementPolicy;
  readonly world: WorldView;
  readonly hasCalculationFallback: boolean;
}): readonly BlockPosition[] | null {
  if (hasCalculationFallback || policy.allowPlacing || policy.allowDigging) return null;
  if (observation.stance !== "supported") return null;
  const start = navigationFeet(observation.position, true);
  if (!isDry(world.blockAt(start.x, start.y, start.z)) || !isDry(world.blockAt(start.x, start.y + 1, start.z))) return null;
  if (goal.finish !== undefined) return null;
  const endpoints = goal.endpoints?.(MAX_PROOF_CUBE);
  if (!endpoints || endpoints.satisfies !== goal.isSatisfied) return null;

  const candidates: BlockPosition[] = [];
  for (const cell of endpoints.cells) {
    const feet = world.blockAt(cell.x, cell.y, cell.z);
    const head = world.blockAt(cell.x, cell.y + 1, cell.z);
    if (feet.kind !== "loaded" || head.kind !== "loaded") return null;
    if (!blocksEndpoint(feet) && !blocksEndpoint(head)) candidates.push(cell);
  }
  return candidates.length > 0 ? candidates : null;
}

/** Opening a passage can make its cell usable even when the plan cannot dig. */
function blocksEndpoint(block: Extract<BlockObservation, { kind: "loaded" }>): boolean {
  return (block.bits & GEOMETRY_FULL_CUBE) !== 0 && !block.traits.openable;
}
