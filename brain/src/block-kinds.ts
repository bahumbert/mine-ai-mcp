// Reads of a block kind's game data (its tags), so no brain code decides what a block is from its name.
import type { BlockKind } from "./runtime-client.ts";

/** Whether the block is tree canopy (the game's `leaves` tag): it looks like cover from below but is no roof. */
export function isCanopy(kind: BlockKind | undefined): boolean {
  return kind?.tags?.includes("leaves") === true;
}
