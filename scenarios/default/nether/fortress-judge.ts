// Verdicts for fortress collection and the withdrawal that can follow a safe refusal.
import type { ActionResult } from "../../../src/actions/action.ts";
import { huntTerminationSchema } from "../../../src/actions/hunt-mob/contract.ts";

/** The action's structured codes for the shield gate and combat capability refusals. */
export const SAFE_HUNT_REFUSALS: ReadonlySet<string> = new Set([
  huntTerminationSchema.enum.shield_required,
  huntTerminationSchema.enum.capability_blocked,
]);

type HuntResult = { readonly status: ActionResult["status"]; readonly termination?: unknown; readonly error?: string };

interface FortressHuntSample {
  readonly alive: boolean;
  readonly quotaMet: boolean;
  readonly hunt: HuntResult;
  readonly handBack: { readonly status: ActionResult["status"]; readonly arrived: boolean } | null;
}

/** Only a documented action refusal can start the hand-back navigation. */
export function isSafeHuntRefusal(hunt: HuntResult): boolean {
  return (hunt.status === "failed" || hunt.status === "partial") &&
    typeof hunt.termination === "string" && SAFE_HUNT_REFUSALS.has(hunt.termination);
}

/** Keep quota evidence and require a successful, server-confirmed next action after a safe refusal. */
export function judgeFortressHunt(sample: FortressHuntSample): { outcome: "quota" | "hand_back" | null; reason: string | null } {
  const { alive, quotaMet, hunt, handBack } = sample;
  if (!alive) return { outcome: null, reason: "The bot did not survive." };
  if (quotaMet) return { outcome: "quota", reason: hunt.status === "succeeded" ? null :
    `The quota was met but the hunt returned ${hunt.status}: ${hunt.error ?? "no error recorded"}` };
  if (!isSafeHuntRefusal(hunt)) return { outcome: null, reason: "The hunt missed the quota without a safe refusal." };
  if (handBack?.status !== "succeeded" || !handBack.arrived)
    return { outcome: null, reason: "The hand-back navigation did not succeed with server-confirmed arrival." };
  return { outcome: "hand_back", reason: null };
}
