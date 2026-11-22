// Settle a mining run from its observed quantity, rejections, and weighing evidence.
import type { MineResult, MineTarget } from "./mine-process.js";
import type { MineTargeting } from "./mine-targeting.js";

function rejectionSummary(rejections: ReadonlyMap<string, number>): string {
  const total = [...rejections.values()].reduce((sum, count) => sum + count, 0);
  const detail = [...rejections.entries()]
    .sort(([, left], [, right]) => right - left)
    .map(([reason, count]) => (count === 1 ? reason : `${reason} (×${count})`))
    .join("; ");
  return `${total} loaded matching block(s) cannot be mined: ${detail}`;
}

/** Preserve an attempted drain's failure; only a wholly unattempted drowned scan gets the special refusal. */
function rejectedTargetsResult(targeting: MineTargeting): MineResult {
  const summary = rejectionSummary(targeting.rejections);
  targeting.lastReason = targeting.blacklisted > 0 && targeting.lastReason
    ? `${targeting.lastReason}; ${summary}` : summary;
  const total = [...targeting.rejections.values()].reduce((sum, count) => sum + count, 0);
  const satisfied = targeting.isSatisfied();
  return {
    status: satisfied ? "satisfied" : "unreachable", broken: targeting.broken, reason: targeting.lastReason,
    ...targeting.weighing.result(),
    ...(!satisfied && !targeting.attemptedWork && targeting.blacklisted === 0 && targeting.underWaterRejections === total && { underWater: true as const }),
  };
}

/** Settle with the quantity and weighing evidence observed by this run. */
export function settledMineResult(targeting: MineTargeting, status: MineResult["status"]): MineResult {
  return {
    status: targeting.isSatisfied() ? "satisfied" : status,
    broken: targeting.broken,
    reason: targeting.lastReason,
    ...targeting.weighing.result(),
  };
}

/** End an empty or failed scan without confusing rejected targets with an unexplored world. */
export function mineStopAfterScan(targeting: MineTargeting, targets: readonly MineTarget[]): MineResult | null {
  if (targeting.waterFailure !== null) return settledMineResult(targeting, "unreachable");
  if (targets.length > 0) return null;
  // Rejections and exhausted blacklists prove matching targets existed; an empty unexplored scan does not.
  if (targeting.rejections.size > 0) return rejectedTargetsResult(targeting);
  if (targeting.explorationFailure !== null) return settledMineResult(targeting, "stopped");
  return targeting.exploring ? null : settledMineResult(targeting, targeting.blacklisted > 0 ? "unreachable" : "no_targets");
}
