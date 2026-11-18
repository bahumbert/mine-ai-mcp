import type { ResponseContinuation } from "../contract.js";
import type { AnsweredEntry, Facts } from "../../state/answered.js";
import type { HostileResponseResult, HostileSettlement } from "./response-result.js";
import { evadeDetail } from "../../responses/evade-detail.js";
import { chainSuffix } from "../../state/threat-chains.js";
import { stallReason } from "../../state/request-stall.js";

/** An occupied shell hands back only after a confirmed kill or separation. */
function settledResponse(physical: HostileResponseResult): HostileResponseResult {
  if (physical.response !== "hide" || physical.healthAfter <= 0 || !physical.followUp) return physical;
  const next = physical.followUp;
  return next.healthAfter > 0 && (next.response === "fight" ? next.result.kind === "died" : next.result.kind === "separated")
    ? next : physical;
}

export function completeResponse(physical: HostileResponseResult, signal: AbortSignal): HostileSettlement {
  const { result: _result, response, ...evidence } = settledResponse(physical);
  const common = { response, physical, evidence, chain: null, stall: null };
  return signal.aborted
    ? {
        ...common,
        kind: "cancelled",
        reason: signal.reason instanceof Error ? signal.reason.message : String(signal.reason),
      }
    : { ...common, kind: "completed" };
}

function responseSummary(physical: HostileResponseResult): { outcome: string; error: string | null } {
  switch (physical.response) {
    case "evade":
      return physical.result.kind === "separated"
        ? { outcome: "safe_separation", error: null }
        : { outcome: physical.result.kind === "failed" ? "failed" : "capability_limit", error: physical.result.reason };
    case "deflect":
      return {
        outcome: physical.result.kind === "reflected" ? "projectile_reflected" : "capability_limit",
        error: physical.result.kind === "reflected" ? null : physical.result.observation,
      };
    case "hide":
      return {
        outcome: physical.result.kind === "failed" ? "capability_limit" : "hidden",
        error:
          physical.result.kind === "recovered"
            ? null
            : physical.result.kind === "held"
              ? `Hidden, but health is still ${physical.healthAfter}: ${physical.result.error}.`
              : `Emergency hide failed: ${physical.result.error}.`,
      };
    case "fight": {
      const result = physical.result;
      switch (result.kind) {
        case "died":
          return { outcome: "target_died", error: null };
        case "contact_ended":
          return { outcome: "contact_ended", error: null };
        case "target_lost":
          return { outcome: "target_lost", error: `Target ${result.targetId} disappeared without an observed death.` };
        case "unreachable":
          return { outcome: "target_unreachable", error: result.observation };
        case "capability_blocked":
          return { outcome: "capability_limit", error: `${result.reason}: ${result.observation}` };
        case "defence_required":
          return { outcome: "disengaged", error: result.observation };
        case "failed":
          return { outcome: "failed", error: result.observation };
        case "bot_died":
          return { outcome: "bot_died", error: "The bot died during combat." };
        case "cancelled":
          return { outcome: "cancelled", error: "Combat stopped after a policy change." };
      }
    }
  }
}

/** Only the receipt boundary flattens response-specific results into operator vocabulary. */
export function encounterReceipt(settlement: HostileSettlement) {
  const effective = settlement.physical ? settledResponse(settlement.physical) : null;
  const summary =
    settlement.kind === "completed"
      ? responseSummary(settledResponse(settlement.physical))
      : { outcome: settlement.kind, error: settlement.reason };
  return {
    ...settlement.evidence,
    response: settlement.response,
    chain: settlement.chain ? { ...settlement.chain } : null,
    stall: settlement.stall ? { ...settlement.stall,
      threats: settlement.stall.threats.map((threat) => ({ ...threat })) } : null,
    outcome: summary.outcome,
    ...(summary.error === null ? {} : { error: summary.error }),
    ...(effective?.response === "evade" ? {
      ends: effective.ends.map((end) => ({ ...end })),
      startPosition: { ...effective.startPosition }, elapsedMs: effective.elapsedMs,
      elapsedTicks: effective.elapsedTicks,
      goalRefreshes: effective.goalRefreshes,
      ...(settlement.kind === "completed" && effective.result.kind === "separated"
        ? { detail: evadeDetail(effective.ends) } : {}),
    } : {}),
    hide: settlement.physical?.response === "hide" ? settlement.physical.result : null,
    followUp: settlement.physical?.response === "hide" ? settlement.physical.followUp : null,
  };
}

/** A successful chain keeps its receipt too; only unsuccessful outcomes need the failure detail. */
function settlementReason(settlement: HostileSettlement, resumed = false): string {
  const receipt = encounterReceipt(settlement);
  const detail = resumed ? "" : `: ${receipt.error ?? receipt.reason}`;
  const chain = settlement.chain && settlement.chain.responses >= 2 ? chainSuffix(settlement.chain) : "";
  return `[HOSTILE_SETTLED] ${receipt.response} ended with ${receipt.outcome} at health ${receipt.healthAfter}${detail}${chain}.`;
}

export function responseContinuation(settlement: HostileSettlement): ResponseContinuation {
  if (settlement.stall?.limit) return { kind: "return", reason: stallReason(settlement.stall) };
  // Observed separation or a completed defence permits current-condition
  // validation; an exhausted response leaves the reflex's next decision open (P4-29 a6).
  if (settlement.kind === "completed" && settlement.evidence.healthAfter > 0) {
    const physical = settledResponse(settlement.physical);
    const resume =
      physical.response === "fight"
        ? ["died", "target_lost", "unreachable", "contact_ended"].includes(physical.result.kind)
        : physical.response === "hide"
          ? physical.result.kind === "recovered"
          : physical.response === "evade"
            ? physical.result.kind === "separated"
            : physical.result.kind === "reflected";
    if (resume) return settlement.chain && settlement.chain.responses >= 2
      ? { kind: "resume", reason: settlementReason(settlement, true) } : { kind: "resume" };
    if (physical.response === "evade" && physical.result.kind === "exhausted"
      || physical.response === "deflect" && physical.result.kind !== "reflected")
      return { kind: "hold", reason: settlementReason(settlement) };
  }
  return { kind: "return", reason: settlementReason(settlement) };
}

export function responseFailure(settlement: HostileSettlement): AnsweredEntry["failure"] | null {
  if (settlement.kind !== "completed")
    return settlement.kind === "failed" ? { kind: "failed", why: settlement.reason } : null;
  const physical = settledResponse(settlement.physical);
  switch (physical.response) {
    case "fight": {
      const result = physical.result;
      if (["died", "contact_ended", "cancelled", "bot_died"].includes(result.kind)) return null;
      return {
        kind: result.kind === "unreachable" && result.premise === "no_confirmed_damage" ? result.premise : result.kind,
        why: "observation" in result ? result.observation : "The target left observation without a death.",
      };
    }
    case "hide":
      return physical.result.kind === "failed"
        ? { kind: "enclosure_failed", why: physical.result.error ?? "The enclosure could not be completed." }
        : null;
    case "evade":
      return physical.result.kind === "separated" ? null : { kind: physical.result.kind, why: physical.result.reason };
    case "deflect":
      return physical.result.kind === "reflected"
        ? null
        : { kind: "deflection_unobserved", why: physical.result.observation };
  }
}

export function describeResponse(settlement: HostileSettlement): Facts {
  const receipt = encounterReceipt(settlement);
  return {
    ...receipt,
    followUp: receipt.followUp ? {
      ...(receipt.followUp.response === "evade" ? {
        ...receipt.followUp,
        startPosition: { ...receipt.followUp.startPosition }, ends: receipt.followUp.ends.map(end => ({ ...end })),
      } : receipt.followUp),
      result: { ...receipt.followUp.result },
      finalPosition: { ...receipt.followUp.finalPosition },
      threats: receipt.followUp.threats.map(threat => ({ ...threat, position: { ...threat.position } })),
      finalDistances: receipt.followUp.finalDistances.map(entry => ({ ...entry })),
    } : null,
    error: receipt.error ?? null,
    threats: receipt.threats.map((threat) => ({ ...threat, position: { ...threat.position } })),
    finalPosition: { ...receipt.finalPosition },
    finalDistances: receipt.finalDistances.map((entry) => ({ ...entry })),
    hide: receipt.hide ? { ...receipt.hide, error: receipt.hide.error ?? null } : null,
    physical: settlement.physical
      ? {
          response: settlement.physical.response,
          result:
            settlement.physical.response === "hide"
              ? { ...settlement.physical.result, error: settlement.physical.result.error ?? null }
              : { ...settlement.physical.result },
        }
      : null,
  };
}
