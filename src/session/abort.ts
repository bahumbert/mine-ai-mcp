/** Which limit a reflex that held the body ran into: no physics tick, its ceiling, or no progress for its window. */
export type ReflexLimitKind = "physics_stalled" | "ceiling" | "no_progress";

/** Why an owner must release. A dimension transition is never a death. */
export type BodyAbortCause =
  | { readonly kind: "preempted"; readonly by: string }
  | { readonly kind: "policy_changed"; readonly revision: string }
  | { readonly kind: "cancelled"; readonly by: "model" | "runtime" }
  | { readonly kind: "connection_lost" }
  | { readonly kind: "death" }
  | { readonly kind: "dimension_changed"; readonly from: string; readonly to: string }
  | { readonly kind: "reflex_limit"; readonly reflex: string; readonly limit: ReflexLimitKind; readonly elapsedMs: number };

/** Still an Error for physical APIs; consumers branch on the cause, never its prose. */
export class BodyAbort extends Error {
  constructor(
    readonly detail: BodyAbortCause,
    message: string,
  ) {
    super(message);
    this.name = "BodyAbort";
  }
}

export type Continuation =
  | { readonly kind: "resume" }
  | { readonly kind: "return"; readonly reason: string | null }
  | { readonly kind: "cancel"; readonly cause: BodyAbortCause };
