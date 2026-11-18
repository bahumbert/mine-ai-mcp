import type { Facts } from "../state/answered.js";
import type { SurvivalReceipt, SurvivalStatus } from "./contract.js";
import { chainSuffix } from "../state/threat-chains.js";
import { stallReason } from "../state/request-stall.js";

/** Read only structured facts; older receipts may have no outcome or stall. */
function object(value: Facts | undefined): Record<string, Facts> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, Facts> : {};
}

/** A stalled request uses the same factual explanation in the outcome preview and the runner return. */
function stalledOutcome(value: Facts | undefined): string | null {
  const stall = object(value);
  if ((stall.limit !== "evades" && stall.limit !== "ticks" && stall.limit !== "wall")
    || typeof stall.requestId !== "string" || typeof stall.action !== "string" || typeof stall.evades !== "number"
    || (stall.ticks !== null && typeof stall.ticks !== "number")
    || (stall.best !== null && typeof stall.best !== "number")
    || (stall.current !== null && typeof stall.current !== "number") || !Array.isArray(stall.threats)) return null;
  const threats = stall.threats.map(object);
  if (threats.some((threat) => typeof threat.id !== "number" || typeof threat.name !== "string")) return null;
  return stallReason({ requestId: stall.requestId, action: stall.action, evades: stall.evades, ticks: stall.ticks,
    best: stall.best, current: stall.current, limit: stall.limit,
    threats: threats.map((threat) => ({ id: threat.id as number, name: threat.name as string })) });
}

function label(value: string): string {
  return value.replace(/_reflex$/, "").replaceAll("_", " ");
}

/** Routine replies show outcomes and actionable warnings; JSON retains the full snapshot. */
export function formatSurvivalStatus(status: SurvivalStatus): string {
  const lines = [`**Vitals:** Health ${status.vitals.health}/20; hunger ${status.vitals.food}/20.`];
  if (status.summary === "dead") lines.push("**Survival:** The bot died.");
  if (!status.owner.connected) {
    lines.push("**Warning:** Minecraft is disconnected; current safety cannot be assessed.");
    return lines.join("\n\n");
  }
  if (status.summary === "dead") return lines.join("\n\n");

  if (status.response) {
    lines.push(`**Survival:** Automatic ${label(status.response.capability)} response in progress (${label(status.response.kind)}).`);
  } else if (status.summary === "standing_down") {
    lines.push("**Survival:** The automatic response is standing down.");
  }
  for (const danger of status.dangers) {
    if (danger.unresolved) {
      lines.push(`**Warning:** Unresolved ${label(danger.reflex)} danger${danger.stale ? "; its last observation is stale" : ""}.`);
    }
  }
  if (status.summary === "standing_down") {
    for (const answer of status.answered) lines.push(`**Survival limitation:** ${answer.failure.why}`);
  }
  if (status.policy.constraint) lines.push(`**Survival limitation:** ${status.policy.constraint}`);

  // Missing oxygen is actionable in water, not a routine warning during work on land.
  for (const missing of status.observations.missing) {
    if (missing === "own_air_metadata") {
      if (status.vitals.inWater) {
        lines.push("**Warning:** The bot is in water, but its air supply is unavailable; the breath reflex cannot assess its remaining air.");
      }
    } else {
      lines.push(`**Warning:** A survival check is unavailable: ${label(missing)}.`);
    }
  }
  for (const stale of status.observations.stale) {
    if (stale === "breath_reflex" && !status.vitals.inWater) continue;
    lines.push(`**Warning:** The ${label(stale)} survival observation is stale.`);
  }
  return [...new Set(lines)].join("\n\n");
}

/** One outcome preview, with observed effects rather than internal phase chatter. */
export function formatSurvivalOutcome(receipt: SurvivalReceipt): string {
  const evidence = object(receipt.evidence);
  const outcome = object(evidence.outcome);
  const interrupted = object(evidence.interrupted);
  const result = outcome.kind ?? outcome.outcome ?? evidence.kind ?? receipt.status.summary;
  const parts = [`${label(receipt.source)}: ${label(String(result))}`];
  const decision = object(evidence.decision);
  const selection = object(evidence.selection ?? decision.selection);
  const inputs = object(selection.inputs ?? decision.inputs ?? evidence.inputs);
  const assessment = object(inputs.assessment);
  if ("margin" in assessment) {
    const policy = object(inputs.policy);
    const weapon = object(assessment.weapon);
    const margin = typeof assessment.margin === "number" ? assessment.margin.toFixed(1) : "unknown";
    parts.push(`margin ${margin} (fight_margin ${policy.fight_margin}), weapon ${weapon.item ?? "bare hands"}`);
  }
  if (typeof outcome.food === "string") parts.push(label(outcome.food));
  if (typeof interrupted.action === "string") parts.push(`interrupted ${interrupted.action}`);
  for (const [name, before, after] of [["health", outcome.healthBefore, outcome.healthAfter], ["hunger", outcome.hungerBefore, outcome.hungerAfter]] as const) {
    if (typeof before === "number" && typeof after === "number") parts.push(`${name} ${before} → ${after}/20`);
  }
  if (evidence.cancelled === true && result !== "cancelled") parts.push("cancelled");
  const error = outcome.error ?? evidence.why;
  if (typeof error === "string") parts.push(error);
  if (typeof outcome.detail === "string") parts.push(outcome.detail);
  const chain = object(outcome.chain);
  if (typeof chain.responses === "number" && chain.responses >= 2 && typeof chain.threatId === "number"
    && typeof chain.name === "string" && typeof chain.evades === "number" && typeof chain.seconds === "number"
    && typeof chain.gained === "number") parts.push(chainSuffix({ responses: chain.responses,
      threatId: chain.threatId, name: chain.name, evades: chain.evades, seconds: chain.seconds, gained: chain.gained }).slice(2));
  const stall = stalledOutcome(outcome.stall);
  if (stall) parts.push(stall);
  return parts.join("; ");
}
