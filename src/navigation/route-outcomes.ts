/** How the routes of one bot ended, for the session to tell a failed route from any other failure of a movement action. */
import type { NavigationResult } from "./navigate.js";

export class RouteOutcomes {
  #settled = 0;
  #lastFailed = false;

  /** Records how a route ended and hands the result back, so the navigation runtime can pass its result through this. */
  note<Result extends NavigationResult>(result: Result): Result {
    this.#settled += 1;
    this.#lastFailed = result.status === "stopped" && result.routeFailed === true;
    return result;
  }

  /** How many routes have settled so far; an action takes it before it runs and asks {@link failedSince} after. */
  mark(): number {
    return this.#settled;
  }

  /**
   * Whether the last route to settle since `mark` failed itself (no path, no progress, a movement that failed): the one
   * that decided how the action ended. A route stopped by its caller or a tool loss, an earlier route that a later one
   * made up for, and no route at all are not.
   */
  failedSince(mark: number): boolean {
    return this.#settled > mark && this.#lastFailed;
  }
}
