import type { Continuation } from "../../session/abort.js";
import type { AnsweredEntry, AnsweredScope, Facts } from "../state/answered.js";
import type { REFLEX_PRIORITY } from "./priority.js";
export type ReflexName = (typeof REFLEX_PRIORITY)[number];

export type DangerObservation<Danger> =
  | { readonly kind: "observed"; readonly danger: Danger; readonly evidence: Facts }
  | { readonly kind: "unknown"; readonly missing: string }
  | null;

export type ResponseExclusion =
  | { readonly kind: "prohibited"; readonly field: string }
  | { readonly kind: "missing_equipment"; readonly item: string }
  | { readonly kind: "unsuitable_geometry"; readonly scope: string }
  | { readonly kind: "answered"; readonly entry: number }
  | { readonly kind: "infeasible_now"; readonly premise: string };

export type ResponseDecision<Response> =
  | { readonly kind: "respond"; readonly response: Response; readonly name: string; readonly reason: string }
  | {
      readonly kind: "stand_down";
      readonly candidates: readonly { readonly response: string; readonly excluded: ResponseExclusion }[];
    }
  | { readonly kind: "handled"; readonly by: string };

/** How soon a reflex that fights a lethal, growing danger (drowning, burning) tries again after a failed attempt. */
export const LETHAL_REFLEX_RETRY_MS = 2_000;

/** The two wall-clock limits of a reflex claim, and how long the reflex stands down after hitting one. */
export interface ReflexLimits {
  /** The longest the claim may hold the body, however well it progresses. */
  readonly ceilingMs: number;
  /** How long the claim may go without a progress mark (the base probe's or the reflex's own). */
  readonly noProgressMs: number;
  /** After a limit the scope stays answered this long, whatever the facts do (time only). */
  readonly standDownMs: number;
}

export interface ReflexDefinition<Danger, Response, Outcome> {
  readonly name: ReflexName;
  readonly intervalTicks?: number;
  /** Still senses and responds while the bot is a passenger (hunger eats seated); others read a physics state that is stale then. */
  readonly seated?: boolean;
  sense(): DangerObservation<Danger>;
  decide(danger: Danger): ResponseDecision<Response>;
  /** Captured only on a changed decision, so physics updates cannot flood receipts. */
  decisionFacts?(danger: Danger): Facts;
  facts(response: Response): AnsweredScope;
  /** What this response may hold the body for: the runner releases a claim that runs into either limit. */
  limits(response: Response): ReflexLimits;
  /**
   * The reflex's own progress probes for one claim, besides the base probe (the body travelled a block, its health
   * changed, it died): call `mark(reason)` when the response gets somewhere. Returns the unsubscribe, called when the
   * claim ends.
   */
  progress?(response: Response, mark: (reason: string) => void): () => void;
  act(response: Response, signal: AbortSignal): Promise<Outcome>;
  continuation(outcome: Outcome): Continuation;
  failure(outcome: Outcome): AnsweredEntry["failure"] | null;
  describe(outcome: Outcome): Facts;
  /** An actual temporal dependency of one outcome (a premise that expires), tried before `retryAfterFailureMs`. */
  temporal?(outcome: Outcome): AnsweredEntry["temporal"];
  /**
   * For a danger that grows while the scene stays equal (air running out in still water, burning in static lava): the
   * driver remembers every failure of this reflex (its `failure()` and an exception) as `retry_after_failure`, which
   * expires after this long. The facts still apply: a changed scene reopens the scope sooner. Without it a failure
   * stands until its facts change.
   */
  readonly retryAfterFailureMs?: number;
  releaseAfterAdmission?(): void;
  settled?(response: Response, outcome: Outcome, interrupted: { action: string; startedAt: string } | null): void;
}

export interface ReflexSnapshot {
  readonly name: ReflexName;
  readonly danger: Facts;
  readonly missing: string | null;
  readonly observedAt: number | null;
  readonly stale: boolean;
  readonly decision: Facts;
  readonly response: { readonly name: string; readonly startedAt: number; readonly releasing: boolean } | null;
}

export interface SurvivalTransition {
  readonly kind: "danger" | "decision" | "claim" | "phase" | "outcome";
  readonly reflex: ReflexName;
  readonly evidence: Facts;
}
