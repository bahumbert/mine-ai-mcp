/**
 * A caller's veto over a whole route, asked at eligible inline search starts, route commits and step boundaries.
 *
 * The step field prices cells and never prohibits one, so the search is never pruned by what a caller knows about the
 * world outside the block model (a shooter's line of sight, a claimed building). A caller that owes an obligation
 * about the route as walked - stay out of one entity's sight - cannot express it as a price. It registers an admission
 * instead: navigation can ask whether the endpoints alone prove a refusal, then asks with the planned steps and edits
 * when a route exists. A refusal ends the run with the caller's own words.
 */
import type { PlannedStep } from "./movements/movement.js";
import type { BlockPosition, WorldView } from "./world/world.js";

export interface RouteAdmission {
  /** A refusal proved for every route ending at these cells, or null if one may be admitted or the proof is uncertain. */
  refuteEndpoints?(plan: { readonly start: BlockPosition; readonly endpoints: readonly BlockPosition[] }, world: WorldView): string | null;
  /**
   * The text that refuses the route, or null to admit it. `start` is where the body stands (the arrival, at a step
   * boundary) and `steps` is what remains to walk, each with the operations it plans.
   */
  check(plan: { readonly start: BlockPosition; readonly steps: readonly PlannedStep[] }, world: WorldView): string | null;
}

/** Read afresh for each admission check: null means no obligation holds now. */
export type RouteAdmissionProvider = () => RouteAdmission | null;
