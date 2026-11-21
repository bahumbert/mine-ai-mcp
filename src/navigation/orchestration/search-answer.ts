/** What one search of a run said when it stopped, before the run decides what that means (types only). */
import type { PlanningNode, ResolvedGoal } from "../goals/goal.js";
import type { RoutePlan } from "../movements/movement.js";
import type { NavigationObservation } from "../world/world.js";
import type { NavigationFailure } from "./outcome.js";
import type { NavigationCalculationFailure } from "./process-events.js";

export type ActiveGoal = Extract<ResolvedGoal, { kind: "active" }>;

/** A search that calculated a plan or exhausted its options. */
export type SearchCalculation =
  | { readonly kind: "plan"; readonly plan: RoutePlan; readonly plannedGoal: ActiveGoal; readonly latestGoal: ActiveGoal }
  | {
      readonly kind: "calculation_failed";
      readonly failure: NavigationCalculationFailure;
      readonly observation: NavigationObservation;
    };
export type SearchInterruption =
  | { readonly kind: "stale" }
  /** The search ran dry inside its region bound after its goal was revised: the revised goal needs a search of its own. */
  | { readonly kind: "goal_revised" }
  | { readonly kind: "start_changed" }
  | { readonly kind: "arrived"; readonly node: PlanningNode; readonly observation: NavigationObservation }
  | { readonly kind: "goal_invalid"; readonly failure: NavigationFailure }
  | { readonly kind: "planning_stalled"; readonly failure: NavigationFailure }
  | { readonly kind: "stopped" };
/** What one search said when it stopped, before the run decides what that means. */
export type SearchAnswer =
  | (SearchCalculation & { readonly identity: string })
  | SearchInterruption
  | { readonly kind: "repeated"; readonly identity: string }
  | { readonly kind: "refused"; readonly observation: string; readonly goalRevision: string };

export type SearchObservation =
  | Extract<SearchAnswer, { readonly kind: "start_changed" | "goal_invalid" | "arrived" }>
  | { readonly kind: "continue"; readonly observation: NavigationObservation; readonly latestGoal: ActiveGoal };
