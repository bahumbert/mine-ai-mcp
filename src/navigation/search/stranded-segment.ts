/**
 * Whether a partial route would leave the bot stranded under a roof (run 15, Sana: a 6-step swim segment into a roofed
 * tunnel, the next search failed, the dive was released five blocks inside and she drowned).
 */
import type { RoutePlan } from "../movements/movement.js";
import type { MovementPolicy } from "../movements/policy.js";
import { DIVE_RESERVE_TICKS, swimBreathTicks } from "../world/swimming.js";
import type { WorldView } from "../world/world.js";

/**
 * True when the plan ends with the head under water and the breath left after its swims does not cover the way back to
 * a cell with the head in air plus the dive reserve (or no such cell is known). A plan with no dive admission, or ending
 * with the head in air, never strands.
 */
export function endsStrandedUnderWater(world: WorldView, policy: MovementPolicy, plan: Pick<RoutePlan, "steps" | "endNode">): boolean {
  const dive = policy.dive;
  if (dive === undefined) return false;
  const end = plan.endNode.feet;
  const head = world.blockAt(end.x, end.y + 1, end.z);
  if (head.kind !== "loaded" || (head.traits.liquid !== "water" && !head.traits.waterlogged)) return false;
  const spent = plan.steps.reduce((ticks, step) => ticks + step.cost.expectedTicks, 0);
  const back = swimBreathTicks((x, y, z) => world.blockAt(x, y, z), end);
  return back === null || back + DIVE_RESERVE_TICKS > dive.airTicks - spent;
}
