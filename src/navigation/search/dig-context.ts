/** The dig context (water at the eyes, ground, Aqua Affinity, effects) the planner prices a dig with from a planning state. */
import type { GenerationContext, PlanningState } from "../movements/catalogue.js";
import type { DigContext } from "../movements/policy.js";
import { solidFloorUnder } from "../world/swimming.js";
import type { WorldView } from "../world/world.js";

/**
 * Where the bot will be standing when it swings, not where it is now.
 *
 * Digging underwater without Aqua Affinity is five times slower and digging
 * mid-air is five times slower again, and the estimator already models both.
 * Hardcoding "dry and grounded" at every call site made the planner price an
 * underwater excavation as if it were on land, so it chose routes it then had
 * to pay far more for.
 */
export function digContextAt(context: GenerationContext, state: PlanningState): DigContext {
  const { x, y, z } = state.node.feet;
  const read: WorldView["blockAt"] = (atX, atY, atZ) => state.overlay.blockAt(context.world, atX, atY, atZ);
  const head = read(x, y + 1, z);
  return {
    submergedAtEyes: head.kind === "loaded" && head.traits.liquid === "water",
    onGround: solidFloorUnder(read, state.node.feet),
    // Mining Fatigue is the dangerous direction: it makes a dig slower than
    // the route priced it, so confirmation windows and progress checks fire on
    // a movement that was always going to take longer.
    aquaAffinity: context.player.aquaAffinity,
    effects: context.player.effects,
  };
}
