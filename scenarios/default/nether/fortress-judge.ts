// Verdicts for fortress collection and the withdrawal that can follow a safe refusal.
import type { ActionResult } from "../../../src/actions/action.ts";
import { huntTerminationSchema } from "../../../src/actions/hunt-mob/contract.ts";

/** The action's structured codes for the shield gate and combat capability refusals. */
export const SAFE_HUNT_REFUSALS: ReadonlySet<string> = new Set([
  huntTerminationSchema.enum.shield_required,
  huntTerminationSchema.enum.capability_blocked,
]);

type HuntResult = {
  readonly status: ActionResult["status"];
  readonly termination?: unknown;
  readonly error?: string;
  /** The hunt's own account of where it left the bot: only `safe` lets the hand-back start (`huntHandoffSchema`). */
  readonly handoff?: { readonly kind: string };
};

/** The most returns (a stall or a refused cover route, each followed by one fresh navigate) a passing hand-back may need. */
const MOST_RETURNS = 1;

interface FortressHuntSample {
  readonly alive: boolean;
  readonly quotaMet: boolean;
  readonly hunt: HuntResult;
  /** The hand-back run (`navigateWithOneReturn`) and the server's arrival answer on its last request, which is asked only after a success. */
  readonly handBack: {
    readonly run: { readonly kind: "not_admitted" } | {
      readonly kind: "completed";
      readonly last: { readonly result: { readonly status: ActionResult["status"] } };
      readonly returns: number;
    };
    readonly arrived: boolean;
  } | null;
}

/** Only a documented action refusal, with the hunt's handoff observed safe, can start the hand-back navigation. */
export function isSafeHuntRefusal(hunt: HuntResult): boolean {
  return (hunt.status === "failed" || hunt.status === "partial") &&
    typeof hunt.termination === "string" && SAFE_HUNT_REFUSALS.has(hunt.termination) && hunt.handoff?.kind === "safe";
}

/** Keep quota evidence and require a successful, server-confirmed next action after a safe refusal, with at most one return. */
export function judgeFortressHunt(sample: FortressHuntSample): { outcome: "quota" | "hand_back" | null; reason: string | null } {
  const { alive, quotaMet, hunt, handBack } = sample;
  if (!alive) return { outcome: null, reason: "The bot did not survive." };
  if (quotaMet) return { outcome: "quota", reason: hunt.status === "succeeded" ? null :
    `The quota was met but the hunt returned ${hunt.status}: ${hunt.error ?? "no error recorded"}` };
  if (!isSafeHuntRefusal(hunt)) return { outcome: null, reason: "The hunt missed the quota without a safe refusal and a safe handoff." };
  const run = handBack?.run;
  if (run?.kind !== "completed") return { outcome: null, reason: "The hand-back navigation was never admitted." };
  if (run.last.result.status !== "succeeded" || !handBack?.arrived)
    return { outcome: null, reason: "The hand-back navigation did not succeed with server-confirmed arrival." };
  if (run.returns > MOST_RETURNS)
    return { outcome: null, reason: `The hand-back needed ${run.returns} returns; at most ${MOST_RETURNS} is allowed.` };
  return { outcome: "hand_back", reason: null };
}
