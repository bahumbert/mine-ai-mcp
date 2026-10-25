// What a new server of a placement is created with: lane servers hold their key's settings, single servers a world of their own.
import type { Scenario } from "mine-labs";
import { settingsCommands } from "../arena/settings.ts";
import type { ScenarioServerConfig } from "./config.ts";
import type { Placement } from "./placement.ts";
import type { ServerSpec } from "./pool.ts";

// Mine Labs' FORCELOAD_CHUNK_LIMIT (compile.ts) chunks of 16x16 blocks over the build height 384: the largest region a lane pins and clones.
const LANE_PINNED_CHUNKS = 256;
const BUILD_HEIGHT = 384;
const LANE_BLOCK_LIMIT = LANE_PINNED_CHUNKS * 16 * 16 * BUILD_HEIGHT;

export function serverSpecFor(placement: Placement, scenario: Scenario, config: ScenarioServerConfig): ServerSpec {
  if (placement.kind === "own") return { kind: "single", key: placement.key, heapMb: config.singleHeapMb, setup: [], scenario, reservedFor: placement.reservedFor };
  return {
    kind: "shared", key: placement.key, heapMb: config.sharedHeapMb, scenario: placement.scenario, reservedFor: placement.reservedFor,
    // The block limit is set once per server so no lane's trial changes it under another lane's clone (plan T1).
    setup: [...settingsCommands(placement.settings), `gamerule commandModificationBlockLimit ${LANE_BLOCK_LIMIT}`, "gamerule commandBlockOutput false"],
  };
}
