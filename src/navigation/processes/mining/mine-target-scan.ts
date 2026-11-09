// Scan loaded matching blocks and item drops while preserving rejection evidence.
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { asVec3, cellKey } from "../../../utils/index.js";
import { droppedItemName } from "../../../world/item-pickup.js";
import { findLoadedBlockPositions } from "../../../world/loaded-block-scan.js";
import { standsOnBlock } from "./target-safety.js";
import { scanTargets, WEIGHED_SCAN_LIMIT } from "./target-weighing.js";
import type { MineBlockTarget, MineRequest, MineScan } from "./mine-process.js";

/**
 * How many locations the composite goal may hold, matching Baritone's
 * `maxOreLocationsToConsider`.
 */
export const MAX_MINE_TARGETS = 64;

interface MineBlacklist {
  readonly blockCells: ReadonlySet<string>;
  readonly blockStances: ReadonlyMap<string, ReadonlySet<string>>;
  readonly dropEntities: ReadonlySet<number>;
}

/** Keep the caller's scan order, policy refusals, and optional cost weighting together. */
export function scanMineTargets(bot: Bot, request: MineRequest, blacklist: MineBlacklist): MineScan {
  request.targetCost?.beginScan();
  const feet = bot.entity?.position ?? new Vec3(0, 64, 0);
  // A named cell must not disappear behind the general scan's nearest matches.
  // Otherwise consider every loaded match, as the public block view does:
  // a known target outside a local radius is still a target, not a reason to explore.
  const positions = request.exactTarget
    ? [request.exactTarget]
    : findLoadedBlockPositions(bot, {
        center: feet,
        stateIds: request.matchingStateIds,
        limit: request.targetCost ? WEIGHED_SCAN_LIMIT : 256,
      });
  const blocks: MineBlockTarget[] = [];
  const rejections = new Map<string, number>();
  let underWaterRejections = 0;
  for (const position of positions) {
    const key = cellKey(position);
    if (blacklist.blockCells.has(key)) continue;
    const block = bot.blockAt(asVec3(position));
    if (block === null || !request.matches(block)) continue;
    const decision = request.canMine(block);
    if (decision.kind !== "mineable") {
      rejections.set(decision.reason, (rejections.get(decision.reason) ?? 0) + 1);
      if (decision.underWater) underWaterRejections += 1;
      continue;
    }
    // The block under the bot's feet stays a target; only its top cell stops being a stance to work it from.
    const excludedStances = new Set(blacklist.blockStances.get(key));
    for (const stance of decision.drained?.wetStances ?? []) excludedStances.add(cellKey(stance));
    if (standsOnBlock(bot, block.position)) excludedStances.add(cellKey({ x: block.position.x, y: block.position.y + 1, z: block.position.z }));
    blocks.push({ position: block.position, kind: "block", routeMayBreak: decision.routeMayBreak, excludedStances,
      ...(decision.drained && { drained: true as const }) });
    if (!request.targetCost && blocks.length === MAX_MINE_TARGETS) break;
  }

  const drops = Object.values(bot.entities ?? {})
    .filter((entity) => {
      const name = droppedItemName(entity);
      return name !== null && request.collects(name);
    })
    .filter((entity) => !blacklist.dropEntities.has(entity.id) && !request.ignoredDropIds?.has(entity.id))
    .map((entity) => ({ position: entity.position.floored(), kind: "drop" as const, entityId: entity.id }));

  return { ...scanTargets(blocks, drops, feet, request.targetCost, MAX_MINE_TARGETS), rejections, underWaterRejections };
}
