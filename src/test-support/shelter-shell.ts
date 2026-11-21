// The cells of a closed shelter around a bot standing at (0, 64, 0), shared by the shelter tests.
import type { FakeCell } from "./fake-bot/index.js";

/** The eight wall cells (feet and head height) and the cap around a bot standing at (0, 64, 0): the box the hide closes. */
export function sealedBox(block: FakeCell = "stone"): Record<string, FakeCell> {
  return Object.fromEntries([
    ...[[1, 0], [-1, 0], [0, 1], [0, -1]].flatMap(([x, z]) => [64, 65].map((y) => [`${x},${y},${z}`, block])),
    ["0,66,0", block],
  ]);
}

/** The same box as `sealedBox("stone")`: what a test spreads into `cells` for a shelter that already stands. */
export const SEALED_BOX: Record<string, FakeCell> = sealedBox();
