import type { ProtectedRegionStore } from "../../bot-data/protected-regions.js";
import { describeProtectedRegion } from "../../world/protected-regions.js";
import { defineAction } from "../action.js";
import { regionResult } from "../protect-region/contract.js";
import {
  parseUnprotectRegionRequest,
  UNPROTECT_REGION,
  UNPROTECT_REGION_DESCRIPTION,
  unprotectRegionAnnotations,
  unprotectRegionInputSchema,
  unprotectRegionOutcomes,
  unprotectRegionResultSchema,
  type UnprotectRegionResult,
} from "./contract.js";

export function formatUnprotectRegionResult(result: UnprotectRegionResult): string {
  if (result.status !== "succeeded" || result.region === null) {
    return `**Not removed:** ${"error" in result ? result.error : "no region was removed."}`;
  }
  return `Removed ${describeProtectedRegion(result.region)}.`;
}

/** Removes a region; like protecting one, it does not need the body. */
export function createUnprotectRegionAction(regions: ProtectedRegionStore) {
  return defineAction({
    name: UNPROTECT_REGION,
    description: UNPROTECT_REGION_DESCRIPTION,
    inputSchema: unprotectRegionInputSchema,
    resultSchema: unprotectRegionResultSchema,
    parse: parseUnprotectRegionRequest,
    execution: { kind: "concurrent" },
    annotations: unprotectRegionAnnotations,
    formatResult: formatUnprotectRegionResult,
    execute: async (request, context): Promise<UnprotectRegionResult> => {
      context.signal?.throwIfAborted();
      const outcome = regions.unprotect(request.regionId);
      switch (outcome.kind) {
        case "removed":
          return { status: "succeeded", region: regionResult(outcome.region) };
        case "not_held":
          return { status: "failed", error: unprotectRegionOutcomes.notHeld(request.regionId, outcome.region.heldBy), region: null };
        case "not_found":
          return { status: "failed", error: unprotectRegionOutcomes.notFound(request.regionId), region: null };
      }
    },
  });
}
