/**
 * A goal is the question search is trying to answer.
 *
 * A goal can move — an entity goal follows its entity — so it is never judged
 * directly. Resolving it against one observation freezes the question: its
 * revision, its heuristic, and its satisfaction predicate then hold for that
 * observation, so a search slice cannot be judged against a goal that moved
 * underneath it.
 */
import type { BlockPosition, NavigationObservation, WorldView } from "../world/world.js";
import type { GeneratedMovement, GenerationContext, PlanningState } from "../movements/catalogue.js";
import type { DigContext } from "../movements/policy.js";
export interface PlanningNode {
  readonly feet: BlockPosition;
  readonly remainingScaffolds: number;
  readonly overlayId: string;
}

export type GoalEndPredicate = (node: PlanningNode, observation: NavigationObservation) => boolean;

/** A lower bound in blocks from a feet cell to the nearest cell this part accepts. */
export interface GoalRegionPart {
  readonly straight: number;
  distance(feet: BlockPosition): number;
}
export interface GoalRegion {
  readonly satisfies: (node: PlanningNode, world: WorldView) => boolean;
  readonly parts: readonly GoalRegionPart[];
}

export type ResolvedGoal =
  | {
      readonly kind: "active";
      /**
       * Changes exactly when this goal's answer could change, and never
       * otherwise. A static goal's revision is its name; an entity goal's is
       * the entity's id and cell; a composite's is its branches' joined.
       *
       * It is the goal's part of the search identity, which is how the run
       * tells a new question from one it has already asked, and it is the
       * label a search reports, so it should read as one.
       */
      readonly revision: string;
      heuristic(node: PlanningNode): number;
      /** Distance remaining for partial-route selection, when it differs from A* ordering. */
      progress?(node: PlanningNode): number;
      /** Search supplies predicted edits; arrival supplies the observed world. */
      isSatisfied(node: PlanningNode, world: WorldView): boolean;
      region?(root: BlockPosition): GoalRegion | null;
      /**
       * Every integer feet cell `satisfies` accepts, or null for an unbounded set, a cube over `limit`,
       * or a fractional centre. `satisfies` is the goal's own `isSatisfied` function object.
       */
      endpoints?(limit: number): {
        readonly satisfies: (node: PlanningNode, world: WorldView) => boolean;
        readonly cells: readonly BlockPosition[];
      } | null;
      /** Work priced alongside travel; only the physical search root receives an actual pose. */
      finish?(
        state: PlanningState,
        context: GenerationContext,
        digContext: DigContext,
        actualStart?: NavigationObservation,
      ): GeneratedMovement | null;
    }
  | { readonly kind: "invalid"; readonly observation: string };

export interface Goal {
  resolve(observation: NavigationObservation): ResolvedGoal;
}
