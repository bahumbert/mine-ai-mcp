import type { Bot } from "mineflayer";
import type { ProtectedRegionStore } from "../../bot-data/protected-regions.js";
import { describeProtectedRegion } from "../../world/protected-regions.js";
import { defineAction } from "../action.js";
import {
  parseProtectRegionRequest,
  PROTECT_REGION,
  PROTECT_REGION_DESCRIPTION,
  protectRegionAnnotations,
  protectRegionInputSchema,
  protectRegionOutcomes,
  protectRegionResultSchema,
  type ProtectRegionResult,
} from "./contract.js";

export function formatProtectRegionResult(result: ProtectRegionResult): string {
  if (result.status !== "succeeded" || result.region === null) {
    return `**Not protected:** ${"error" in result ? result.error : "no region was stored."}`;
  }
  const { region } = result;
  return (
    `${result.created ? "Stored" : "Already stored"} ${describeProtectedRegion(region)}: ` +
    `${region.min.x},${region.min.y},${region.min.z} to ${region.max.x},${region.max.y},${region.max.z} in \`${region.dimension}\`.`
  );
}

/** Writes a region; the body is not needed, so it runs beside whatever the bot is doing. */
export function createProtectRegionAction(bot: Bot, regions: ProtectedRegionStore) {
  return defineAction({
    name: PROTECT_REGION,
    description: PROTECT_REGION_DESCRIPTION,
    inputSchema: protectRegionInputSchema,
    resultSchema: protectRegionResultSchema,
    parse: parseProtectRegionRequest,
    execution: { kind: "concurrent" },
    annotations: protectRegionAnnotations,
    formatResult: formatProtectRegionResult,
    execute: async (request, context): Promise<ProtectRegionResult> => {
      context.signal?.throwIfAborted();
      const outcome = regions.protect({
        dimension: bot.game.dimension,
        min: request.min,
        max: request.max,
        owner: request.owner ?? bot.username,
        label: request.label,
        reason: request.reason,
        createdBy: bot.username,
      });
      switch (outcome.kind) {
        case "created":
        case "existing":
          return { status: "succeeded", region: outcome.region, created: outcome.kind === "created" };
        case "too_large":
          return { status: "failed", error: protectRegionOutcomes.tooLarge(outcome.side), region: null, created: false };
        case "limit_reached":
          return { status: "failed", error: protectRegionOutcomes.limitReached(), region: null, created: false };
      }
    },
  });
}
