// Classifies a scenario result using the bench events observed during its run.
import type { RunResult } from "mine-labs";

export type ResultClass = "pass" | "product" | "infra" | "cancelled";
export interface ClassInput {
  readonly outcome: RunResult["outcome"];
  readonly placement: "lane" | "own";
  readonly submissionCancelled: boolean;
  readonly startFailed: string | null;
  readonly diedBeforeSettle: string | null;
  readonly transportFailure: string | null;
  readonly hitWallBound: boolean;
  readonly late: boolean;
  readonly harnessError: string | null;
  readonly phases: string | null;
  readonly detail?: string;
}
export interface Classified { readonly class: ResultClass; readonly cause?: string; readonly selfMade?: boolean }

/** Classifies the runner's outcome using bench events, in order of precedence. */
export function classifyEnd(input: ClassInput): Classified {
  if (input.outcome === "pass") return { class: "pass" };
  if (input.submissionCancelled) return { class: "cancelled" };
  if (input.startFailed !== null) return { class: "infra", cause: `server did not start: ${input.startFailed}`, selfMade: input.placement === "own" };
  if (input.diedBeforeSettle !== null) return { class: "infra", cause: `server died: ${input.diedBeforeSettle}`, selfMade: true };
  if (input.transportFailure !== null) return { class: "infra", cause: `rcon: ${input.transportFailure}`, selfMade: true };
  if (input.hitWallBound) return { class: "product", cause: `trial passed its wall bound (${input.phases ?? "phases unavailable"})` };
  if (input.late) return { class: "infra", cause: "trial did not settle after its abort", selfMade: true };
  if (input.harnessError !== null) return { class: "infra", cause: input.harnessError, selfMade: false };
  if (input.outcome === "cancelled") return { class: "cancelled" };
  return { class: "product", cause: input.detail };
}
