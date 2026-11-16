// Human-readable end evidence shared by evade receipts and exhaustion results.
import type { EvadeThreatEnd } from "../control/combat/response-result.js";

/** Explain each confirmed reason for separation with its observed distance gain. */
export function evadeDetail(ends: readonly EvadeThreatEnd[]): string {
  return ends.map((end) => {
    const name = `${end.name}#${end.id}`;
    const distance = `${end.distance.toFixed(1)} blocks`;
    if (end.basis === "dead") return `${name} dead`;
    if (end.basis === "range") return `${name} ${distance} away`;
    const reason = end.basis === "cover" ? "out of sight" : "stopped following";
    return `${name} ${reason} at ${distance} (gained ${end.gained.toFixed(1)})`;
  }).join("; ");
}

/** Keep the historical failure clause while exposing what still prevented separation. */
export function evadeExhaustion(reason: string, elapsedMs: number, ends: readonly EvadeThreatEnd[], inFlight: boolean): string {
  const details = ends.filter((end) => end.basis === null).sort((a, b) => a.distance - b.distance).slice(0, 3)
    .map((end) => `${end.name}#${end.id} is ${end.distance.toFixed(1)} blocks away (gained ${end.gained.toFixed(1)}), ${end.advancing === true ? "still following" : end.advancing === false ? "not advancing" : "advancement unobserved"}`);
  if (inFlight) details.push("an incoming projectile or pending explosive clearance prevents separation");
  const clause = reason.endsWith(".") ? reason.slice(0, -1) : reason;
  return `${clause}; after ${(elapsedMs / 1_000).toFixed(1)} s ${details.join("; ") || "the body is not settled"}.`;
}
