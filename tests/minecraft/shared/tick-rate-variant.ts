// Apply a requested tick rate to an already loaded scenario.
import type { Scenario } from "mine-labs";

/** Keep explicit and exclusive rates, and avoid changing the default lane key. */
export function withTickRate(scenario: Scenario, rate: number): { readonly scenario: Scenario; readonly changed: boolean; readonly reason?: "sets its own tick rate" | "exclusive" | "already 20" } {
  if (scenario.setup.some(line => /^tick rate /u.test(line))) return { scenario, changed: false, reason: "sets its own tick rate" };
  if (scenario.tags.includes("exclusive")) return { scenario, changed: false, reason: "exclusive" };
  if (rate === 20) return { scenario, changed: false, reason: "already 20" };
  return { scenario: { ...scenario, setup: [...scenario.setup, `tick rate ${rate}`] }, changed: true };
}
