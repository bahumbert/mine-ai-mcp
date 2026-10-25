/** The goal of the nearest dry ground: found by a search bounded by its own limits, never by a radius (backlog 62). */
import type { Goal } from "./goal.js";
import { ASCENT_TICKS_PER_BLOCK } from "./index.js";
import { standsOnDryGround } from "../world/block-geometry.js";

/**
 * Satisfied where the body stands on dry ground (`standsOnDryGround`). The heuristic is only the climb back to the
 * height the search starts from, which every dry landing out of the water needs: the search spreads along the surface,
 * nearest first, instead of filling the depth of the sea (an eight-deep sea is ~8x the nodes for a uniform search).
 */
export function dryLandGoal(fromY: number): Goal {
  return {
    resolve: () => ({
      kind: "active",
      revision: "dry-land",
      heuristic: (node) => Math.max(0, fromY - node.feet.y) * ASCENT_TICKS_PER_BLOCK,
      isSatisfied: (node, world) => standsOnDryGround((x, y, z) => world.blockAt(x, y, z), node.feet),
    }),
  };
}
