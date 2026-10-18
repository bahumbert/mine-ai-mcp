/**
 * How a goal-directed process stays in charge of its own objective.
 *
 * Reaching a spatial goal, or failing one inline calculation, is an event the
 * caller resolves — navigation does not decide whether the process is done.
 */
import type { PlanningNode } from "../goals/goal.js";
import type { NavigationObservation } from "../world/world.js";
import type { NavigationFailure } from "./outcome.js";

/** A spatial goal was reached, but the caller decides whether its process is done. */
export interface NavigationArrival {
  readonly goalRevision: string;
  readonly node: PlanningNode;
  readonly observation: NavigationObservation;
  readonly signal: AbortSignal;
}

export type NavigationArrivalResult = { readonly kind: "completed" } | { readonly kind: "continue" };

export type NavigationCalculationFailure = Extract<
  NavigationFailure,
  { readonly kind: "no_path" } | { readonly kind: "search_limit" }
>;

/** An inline path calculation failed; the caller may revise its process goal and continue. */
export interface NavigationCalculationFailureEvent {
  readonly failure: NavigationCalculationFailure;
  readonly observation: NavigationObservation;
  readonly signal: AbortSignal;
}

export type NavigationCalculationFailureResult = { readonly kind: "completed" } | { readonly kind: "continue" };

const REFUSAL_PHRASES: Readonly<Record<string, (count: number) => string>> = {
  opens_into_liquid: (count) => `${count} digs would open into water or lava`,
  under_water: (count) => `${count} under water`,
  protected: (count) => `${count} protected`,
  policy_dig_down: (count) => `${count} refused by your rule against digging straight down`,
  unloaded: (count) => `${count} not loaded`,
};

/** What the first digs around the start were refused for, or "" when none was counted. */
function describeStartRefusals(refusals: Readonly<Record<string, number>> | undefined): string {
  const named = Object.entries(refusals ?? {}).sort(([a, x], [b, y]) => y - x || a.localeCompare(b)).map(([cause, count]) => REFUSAL_PHRASES[cause]?.(count) ?? `${count} ${cause}`);
  return named.length === 0 ? "" : `; shut in at the start: ${named.join(", ")}`;
}

/** The one sentence every caller reports for a failed calculation: what ran out, how close it got, and what it was replanning around. */
export function describeCalculationFailure(failure: NavigationCalculationFailure): string {
  const closest = failure.kind === "no_path" ? failure.closest : failure.limit.closest;
  const where = `closest node was ${closest.position.x},${closest.position.y},${closest.position.z}`;
  const { visited, generated, computeMs } = failure.search;
  const spent = `${Math.round(computeMs)} ms compute`;
  const work = `visited ${visited} nodes, generated ${generated}`;
  const stopped =
    failure.kind === "no_path"
      ? `no path found after ${spent}`
      : failure.limit.kind === "search_time"
        ? `search timed out after ${spent} (limit ${failure.limit.limit} ms); no path or usable partial route found`
        : `search radius limit ${failure.limit.limit} blocks reached after ${spent}; no path or usable partial route found`;
  const near = closest.withinStartBlocks;
  // What is known: the node nearest the goal is within `near` blocks of the bot. Only an exhausted search
  // (no_path) shows nothing else is reachable; a timeout or radius limit may just have stopped too soon.
  const shutIn = near === undefined ? "" : describeStartRefusals(failure.search.startRefusals);
  const standing =
    near === undefined
      ? ""
      : `; the node nearest the goal is within ${near} blocks of where the bot stands, so no route found gets it more than ${near} blocks nearer` +
        (shutIn !== "" ? shutIn : failure.kind === "no_path" ? "; every reachable place was searched, so this direction is a dead end from here" : "");
  const what = `${stopped}; ${work}; ${where}${standing}`;
  return failure.after ? `${what}, while replanning after a movement failure: ${failure.after.observation}` : what;
}
