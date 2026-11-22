import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import {
  type FlatPlacementMiss,
  placeBlock,
  searchFlatPlacements,
  supportsFlatPlacement,
  type WorldBlock,
} from "../../world/index.js";

interface BedCandidate {
  readonly foot: Vec3;
  readonly head: Vec3;
  readonly direction: Vec3;
}

type BedPlacementResult =
  | { kind: "placed"; block: WorldBlock; foot: Vec3 }
  | { kind: "failed"; reason: "missing_bed" | "no_footprint" | "placement_failed"; error: string };

interface BedSearch {
  readonly candidates: BedCandidate[];
  readonly misses: Record<FlatPlacementMiss, number>;
  readonly origins: number;
}

const UP = new Vec3(0, 1, 0);
const ORIGIN = new Vec3(0, 0, 0);
const CARDINALS = [new Vec3(0, 0, -1), new Vec3(1, 0, 0), new Vec3(0, 0, 1), new Vec3(-1, 0, 0)];
const BED_SEARCH_RADIUS = 4;
/** The words the no-footprint text gives each refusal, in the order of `FlatPlacementMiss`. */
const MISS_WORDS: Record<FlatPlacementMiss, string> = {
  unloaded: "unloaded",
  body: "in my body",
  wet: "wet",
  blocked: "blocked",
  unsupported: "without a full block under",
};

export function isBedBlock(name?: string | null): boolean {
  return typeof name === "string" && name.endsWith("_bed");
}

/** Describe bed meaning around the generic supported footprint search, summing its refusals over the four directions. */
function findBedPlacementCandidates(bot: Bot, maxRadius = 4): BedSearch {
  const searches = CARDINALS.map((direction) => ({
    direction,
    search: searchFlatPlacements(bot, [ORIGIN, direction], maxRadius),
  }));
  const candidates = searches.flatMap(({ direction, search }) =>
    search.candidates.map((foot) => ({ foot, head: foot.plus(direction), direction })),
  );

  return {
    candidates: candidates.sort((left, right) => bot.entity.position.distanceTo(left.foot) - bot.entity.position.distanceTo(right.foot)),
    misses: sumMisses(searches.map(({ search }) => search.misses)),
    origins: searches.reduce((total, { search }) => total + search.origins, 0),
  };
}

function sumMisses(parts: readonly Record<FlatPlacementMiss, number>[]): Record<FlatPlacementMiss, number> {
  const total: Record<FlatPlacementMiss, number> = { unloaded: 0, body: 0, wet: 0, blocked: 0, unsupported: 0 };
  for (const part of parts) for (const miss of Object.keys(total) as FlatPlacementMiss[]) total[miss] += part[miss];
  return total;
}

/** "12 blocked, 3 without a full block under, 1 unloaded": the refusals that happened, largest first. */
function describeMisses(misses: Record<FlatPlacementMiss, number>): string {
  return (Object.keys(misses) as FlatPlacementMiss[])
    .filter((miss) => misses[miss] > 0)
    .sort((left, right) => misses[right] - misses[left])
    .map((miss) => `${misses[miss]} ${MISS_WORDS[miss]}`)
    .join(", ");
}

/** The refusal of a search that found no footprint: what failed around the bot, and the next action. */
function noFootprintError(search: BedSearch, radius: number): string {
  return (
    `No nearby supported 2-block flat ground found to place a bed (of ${search.origins} footprints within ${radius} blocks ` +
    `along each axis and 1 up or down: ${describeMisses(search.misses)}): go_to open flat ground, two dry clear cells ` +
    "side by side on full blocks, and call sleep again."
  );
}

/**
 * Select a carried bed and try the nearest valid bed footprints. `onPlacementSent` hears each footprint (foot and head)
 * right before the placement packet goes out, so a caller cut off after it knows where its bed may stand; a footprint
 * abandoned before the send is never announced.
 */
export async function placeCarriedBed(
  bot: Bot,
  signal?: AbortSignal,
  onPlacementSent?: (cells: readonly Vec3[]) => void,
): Promise<BedPlacementResult> {
  const bedItem = bot.inventory.items().find((item) => isBedBlock(item.name));
  if (!bedItem) return { kind: "failed", reason: "missing_bed", error: "No bed found in inventory to place." };

  const search = findBedPlacementCandidates(bot, BED_SEARCH_RADIUS);
  const { candidates } = search;
  if (candidates.length === 0) {
    return { kind: "failed", reason: "no_footprint", error: noFootprintError(search, BED_SEARCH_RADIUS) };
  }

  let lastError = "The expected bed did not appear after placement.";
  for (const candidate of candidates.slice(0, 8)) {
    signal?.throwIfAborted();
    const support = bot.blockAt(candidate.foot.offset(0, -1, 0));
    if (!support || !supportsFlatPlacement(support)) continue;

    const result = await placeBlock(bot, {
      item: bedItem,
      support,
      face: UP,
      // Mineflayer can use either half, but the head avoids re-deriving the
      // other half from version-specific bed-state metadata.
      expectedCells: [candidate.head, candidate.foot],
      matches: (block) => isBedBlock(block.name),
      lookDirection: candidate.direction,
      signal,
      onSent: () => onPlacementSent?.([candidate.foot, candidate.head]),
    });
    if (result.kind === "placed") return { kind: "placed", block: result.block, foot: candidate.foot };
    lastError = result.error;
  }

  return {
    kind: "failed",
    reason: "placement_failed",
    error: `Failed to place bed in nearby candidate locations: ${lastError}; go_to other flat ground and call sleep again.`,
  };
}
