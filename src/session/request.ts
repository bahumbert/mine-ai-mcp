import type { Facts } from "../survival/state/answered.js";
import type { BodyAbortCause } from "./abort.js";

/** Action-owned evidence is read from its retained executor, never copied into a new attempt. */
export interface RequestEvidence {
  readonly baseline: Facts;
  readonly checkpoint: Facts;
  readonly completion: { readonly kind: "event" | "current"; readonly observed: boolean; readonly owes: string };
  /**
   * How far the request is from done, lower when closer, for an action that can measure it (navigate); `null` when it
   * cannot be measured now (another dimension); absent for an action that does not publish one. The stall tracker
   * bounds only a request that publishes it (`survival/state/request-stall.ts`).
   */
  readonly objective?: { readonly remaining: number; readonly tolerance: number } | null;
}

export type ObserveRequest = (read: () => RequestEvidence) => void;

export type RequestState =
  | { readonly kind: "admitted" | "running" | "resuming" | "returned" }
  | { readonly kind: "suspended"; readonly by: string; readonly cause: BodyAbortCause };

export interface RequestSnapshot {
  readonly id: string;
  readonly requestId: number | null;
  readonly action: string;
  readonly admittedAt: number;
  readonly state: RequestState;
  readonly objective: unknown;
  readonly evidence: RequestEvidence | null;
  readonly observationError?: string;
}
