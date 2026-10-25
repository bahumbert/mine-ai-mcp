/** The telemetry a search reports when it ends, kept out of the run's loop. */
import type { SearchUpdate } from "../search/search.js";
import type { RunEvent } from "../telemetry/index.js";

type SearchFinished = Extract<RunEvent, { readonly kind: "search_finished" }>;

/** What a finished search's update says in the event: its result, what bound it, and how far to trust it. */
export function searchFinishedEvent(
  searchId: string,
  goalRevision: string,
  update: Exclude<SearchUpdate, { readonly kind: "progress" }>,
): SearchFinished {
  return {
    kind: "search_finished",
    searchId,
    goal: goalRevision,
    result: update.kind,
    counts: update.evidence,
    exhausted:
      update.kind === "no_path"
        ? "frontier"
        : update.kind === "limit"
          ? update.limit.kind === "radius"
            ? "radius"
            : "compute_time"
          : null,
    limit: update.kind === "limit" ? update.limit : null,
    interpretation:
      update.kind === "no_path"
        ? "The explored frontier is exhausted under these observations and movement permissions; this is not proof that all terrain is unreachable."
        : update.kind === "limit"
          ? "The declared search resource was exhausted; geometry outside that search remains untested."
          : "This is the search result, before physical execution and arrival validation.",
  };
}
