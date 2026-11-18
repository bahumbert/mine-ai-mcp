/**
 * A caller's veto over a whole route, asked before the route is walked and again at each step boundary.
 *
 * The step field prices cells and never prohibits one, so the search is never pruned by what a caller knows about the
 * world outside the block model (a shooter's line of sight, a claimed building). A caller that owes an obligation
 * about the route as walked - stay out of one entity's sight - cannot express it as a price. It registers an admission
 * instead: navigation asks it with the planned steps, edits included, and ends the run with the caller's own words
 * when it refuses. Navigation never learns what the obligation is, only that the route was refused and why.
 */
import type { PlannedStep } from "./movements/movement.js";
import type { BlockPosition, WorldView } from "./world/world.js";

export interface RouteAdmission {
  /**
   * The text that refuses the route, or null to admit it. `start` is where the body stands (the arrival, at a step
   * boundary) and `steps` is what remains to walk, each with the operations it plans.
   */
  check(plan: { readonly start: BlockPosition; readonly steps: readonly PlannedStep[] }, world: WorldView): string | null;
}

/** Read at each commit and each step boundary, never cached: null means no obligation holds now. */
export type RouteAdmissionProvider = () => RouteAdmission | null;
