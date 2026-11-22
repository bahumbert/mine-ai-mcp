/**
 * Protected regions (ADR-012): boxes of blocks no route of this bot may dig or scaffold in, such as a house it is
 * building or a player's build it was asked to respect. The store lives in bot-data; navigation reads it through this
 * per-bot provider, like the navigation policy, so every route, collect and automatic response obeys the same list.
 */
import type { Bot } from "mineflayer";
import { isRecordedLifeSavingBlock } from "./life-saving-placements.js";

export interface BlockCorner {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** One protected box, inclusive on every side. */
export interface ProtectedRegion {
  readonly regionId: number;
  readonly dimension: string;
  readonly min: BlockCorner;
  readonly max: BlockCorner;
  /** Whose build it is: the bot's own username or a player's name. */
  readonly owner: string;
  readonly label: string;
  /** The bot that stored it (`created_by_bot_id`). */
  readonly heldBy: string;
  /**
   * True for a region this bot did not store: read from another bot's file, or written by another host of a shared
   * file. Ids belong to one file, so a peer's `regionId` means nothing here, and "own" is `!peer`, never a name.
   */
  readonly peer: boolean;
}

const providers = new WeakMap<Bot, () => readonly ProtectedRegion[]>();

export function setProtectedRegionsProvider(bot: Bot, provider: () => readonly ProtectedRegion[]): void {
  providers.set(bot, provider);
}

/** The regions as they stand now; none for a bot whose runtime set no provider (tests, embedded tools). */
export function readProtectedRegions(bot: Bot): readonly ProtectedRegion[] {
  return providers.get(bot)?.() ?? [];
}

/** Minecraft usernames are case-insensitive, and players type them however they like. */
export function sameOwner(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/** Past this many regions the lookup goes through a chunk-column index instead of walking the array. */
export const REGION_INDEX_THRESHOLD = 16;

/**
 * A region covering more chunk columns than this is not indexed: `protect` keeps a region within 64 blocks (at most 25
 * columns), but a row read from another bot's file is not bound by it, and indexing a huge box would hang or exhaust
 * memory. Such regions are checked one by one.
 */
const MAX_INDEXED_COLUMNS = 64;

/** One dimension: the regions by chunk column (`chunkX * 2^26 + chunkZ`), and the too-large ones; both list array positions in order. */
interface DimensionIndex {
  readonly columns: Map<number, number[]>;
  readonly large: number[];
}
type RegionIndex = ReadonlyMap<string, DimensionIndex>;

const indexes = new WeakMap<readonly ProtectedRegion[], RegionIndex>();

const chunkOf = (coordinate: number) => Math.floor(coordinate / 16);
const chunkKey = (chunkX: number, chunkZ: number) => chunkX * 0x4000000 + chunkZ;

/** Built once per array: the provider's arrays are frozen and replaced when they change, never edited. */
function indexOf(regions: readonly ProtectedRegion[]): RegionIndex {
  const known = indexes.get(regions);
  if (known !== undefined) return known;
  const byDimension = new Map<string, DimensionIndex>();
  regions.forEach((region, position) => {
    let dimension = byDimension.get(region.dimension);
    if (dimension === undefined) byDimension.set(region.dimension, (dimension = { columns: new Map(), large: [] }));
    const [firstX, lastX, firstZ, lastZ] = [chunkOf(region.min.x), chunkOf(region.max.x), chunkOf(region.min.z), chunkOf(region.max.z)];
    if ((lastX - firstX + 1) * (lastZ - firstZ + 1) > MAX_INDEXED_COLUMNS) {
      dimension.large.push(position);
      return;
    }
    for (let chunkX = firstX; chunkX <= lastX; chunkX += 1) {
      for (let chunkZ = firstZ; chunkZ <= lastZ; chunkZ += 1) {
        const key = chunkKey(chunkX, chunkZ);
        const positions = dimension.columns.get(key);
        if (positions === undefined) dimension.columns.set(key, [position]);
        else positions.push(position);
      }
    }
  });
  indexes.set(regions, byDimension);
  return byDimension;
}

/** Only a region this bot stored is its own: a peer's region made "for" it is not its to dig. */
const exempt = (region: ProtectedRegion, exemptOwner: string | undefined) =>
  exemptOwner !== undefined && !region.peer && sameOwner(region.owner, exemptOwner);

const holds = (region: ProtectedRegion, x: number, y: number, z: number) => {
  const { min, max } = region;
  return x >= min.x && x <= max.x && y >= min.y && y <= max.y && z >= min.z && z <= max.z;
};

/**
 * The first region of this dimension holding the cell, in array order, skipping the regions of `exemptOwner` that this
 * bot stored itself. Above `REGION_INDEX_THRESHOLD` regions a per-array chunk-column index answers it (the same region
 * as the linear walk).
 */
export function protectedRegionAt(
  regions: readonly ProtectedRegion[],
  dimension: string,
  x: number,
  y: number,
  z: number,
  exemptOwner?: string,
): ProtectedRegion | null {
  if (regions.length > REGION_INDEX_THRESHOLD) {
    const entry = indexOf(regions).get(dimension);
    if (entry === undefined) return null;
    const matches = (position: number) => !exempt(regions[position]!, exemptOwner) && holds(regions[position]!, x, y, z);
    const inColumn = (entry.columns.get(chunkKey(chunkOf(x), chunkOf(z))) ?? []).find(matches);
    // The first in array order, as the linear walk: a large region counts only when it comes before the column's match.
    const before = entry.large.find((position) => (inColumn === undefined || position < inColumn) && matches(position));
    const found = before ?? inColumn;
    return found === undefined ? null : regions[found]!;
  }
  for (const region of regions) {
    if (region.dimension !== dimension || exempt(region, exemptOwner)) continue;
    if (holds(region, x, y, z)) return region;
  }
  return null;
}

/** What a description needs; a tool result's region carries no `peer` or `heldBy` and is always this bot's own. */
export type DescribedRegion = Pick<ProtectedRegion, "regionId" | "label" | "owner"> & Partial<Pick<ProtectedRegion, "peer" | "heldBy">>;

/** An own region keeps its id (the model may release it); a peer's is named by its holder, never by an id of another file. */
export function describeProtectedRegion(region: DescribedRegion): string {
  return region.peer === true
    ? `${region.heldBy ?? "another bot"}'s protected area '${region.label}' (owner ${region.owner})`
    : `protected region #${region.regionId} '${region.label}' (owner ${region.owner})`;
}

/** A region of someone else holding the cell, or null; the bot's own regions never refuse. Read at each call. */
export function foreignRegionAt(bot: Bot, cell: BlockCorner): ProtectedRegion | null {
  return protectedRegionAt(readProtectedRegions(bot), bot.game.dimension, cell.x, cell.y, cell.z, bot.username);
}

/** Any region (own included) holding the cell: for choosers that prefer cells outside every region. */
export function anyRegionAt(bot: Bot, cell: BlockCorner): ProtectedRegion | null {
  return protectedRegionAt(readProtectedRegions(bot), bot.game.dimension, cell.x, cell.y, cell.z);
}

/** Why a placement or dig was refused here, without the action's own words around it. */
export function regionRefusalText(region: ProtectedRegion): string {
  return `inside ${describeProtectedRegion(region)}`;
}

/**
 * The refusal text for a dig or a placement at a cell inside someone else's region, or null when the cell is free to
 * change (outside every region, or in the bot's own). The one wording every world change outside navigation's routes
 * uses (plan 2026-11-07-p4-06a-threat T5b), so a model reads the same words wherever the change was refused.
 */
export function regionChangeRefusal(bot: Bot, cell: BlockCorner, change: "dig" | "placement"): string | null {
  if (change === "dig" && isRecordedLifeSavingBlock(bot, cell)) return null;
  const region = foreignRegionAt(bot, cell);
  if (region === null) return null;
  const where = `(${cell.x}, ${cell.y}, ${cell.z}) is ${regionRefusalText(region)}`;
  return change === "dig"
    ? `Dig cell ${where}: dig elsewhere or ask its owner.`
    : `Placement cell ${where}: build elsewhere or ask its owner.`;
}

/**
 * The cells in the order a chooser should try them: outside every region, then in the bot's own, then in someone
 * else's (which the placement core refuses). Stable inside each group.
 */
export function cellsOutsideRegionsFirst<T extends BlockCorner>(bot: Bot, cells: readonly T[]): T[] {
  const regions = readProtectedRegions(bot);
  const rank = (cell: BlockCorner): number => {
    if (protectedRegionAt(regions, bot.game.dimension, cell.x, cell.y, cell.z) === null) return 0;
    return protectedRegionAt(regions, bot.game.dimension, cell.x, cell.y, cell.z, bot.username) === null ? 1 : 2;
  };
  return cells
    .map((cell, index) => ({ cell, index, rank: rank(cell) }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(({ cell }) => cell);
}
