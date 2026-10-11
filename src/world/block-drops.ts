/**
 * What blocks drop: each supported version's block loot tables (generated from its server jar by
 * `block-drops-extract.ts`, see `data/block-drops/`), and the questions gathering and farming ask of them.
 */
import drops_1_21_4 from "./data/block-drops/1.21.4.json" with { type: "json" };
import { nearestShipped } from "./shipped-data.js";

interface BlockDropsData {
  readonly version: string;
  readonly blocks: Readonly<Record<string, readonly BlockDrop[]>>;
}

/** Shipped data files, by version. Add a file with `block-drops-extract.ts`, then list it here. */
const SHIPPED: readonly BlockDropsData[] = [drops_1_21_4];

/** One block an item can be gathered from by an ordinary break. */
export interface DropSource {
  readonly block: string;
  readonly chance: number;
  /**
   * The block is a crop someone grows (its loot table has a ripe state: wheat for wheat seeds and for wheat): breaking
   * it takes from a farm, so it comes after the wild sources.
   */
  readonly planted: boolean;
  /** The item the crop is planted from, for a planted source (wheat_seeds for wheat). */
  readonly seed?: string;
}

/** The block drops for `version`: its own file, else the nearest older shipped one, else null. */
export function blockDropsData(version: string): BlockDropsData | null {
  return nearestShipped(version, SHIPPED);
}

/** What breaking `block` by hand may drop, without shears or silk touch, in loot order. */
export function ordinaryDrops(block: string, version: string): readonly BlockDrop[] {
  return (blockDropsData(version)?.blocks[block] ?? []).filter((drop) => drop.tool === undefined);
}

/** The item an ordinary break of `block` yields most often (the first listed on a tie), or null when it drops nothing. */
export function likeliestOrdinaryDrop(block: string, version: string): string | null {
  let best: BlockDrop | null = null;
  for (const drop of ordinaryDrops(block, version)) if (best === null || drop.chance > best.chance) best = drop;
  return best?.item ?? null;
}

/**
 * The ripe state of a crop: the growth `age` its loot table asks before the crop drops (`{ age: "7" }` for wheat). Other
 * state conditions are not ripeness (tall grass drops from its lower half).
 */
export function ripeState(block: string, version: string): Readonly<Record<string, string>> | null {
  return ordinaryDrops(block, version).find((drop) => drop.state?.age !== undefined)?.state ?? null;
}

/** What a crop is planted from: what it drops whatever its state (an unripe crop gives back its seed). */
export function seedOf(block: string, version: string): string | null {
  return ordinaryDrops(block, version).find((drop) => drop.state === undefined)?.item ?? null;
}

/** The blocks an ordinary break gathers `item` from: wild blocks before planted crops, then the likeliest first. */
export function sourcesOf(item: string, version: string): readonly DropSource[] {
  const blocks = blockDropsData(version)?.blocks ?? {};
  const sources: DropSource[] = [];
  for (const block of Object.keys(blocks)) {
    const chance = Math.max(0, ...ordinaryDrops(block, version).filter((drop) => drop.item === item).map((drop) => drop.chance));
    if (chance === 0) continue;
    const planted = ripeState(block, version) !== null;
    const seed = planted ? seedOf(block, version) : null;
    sources.push({ block, chance, planted, ...(seed === null ? {} : { seed }) });
  }
  return sources.sort((a, b) => Number(a.planted) - Number(b.planted) || b.chance - a.chance);
}

/** One possible drop of a block, in loot order. */
export interface BlockDrop {
  readonly item: string;
  /** How likely, with no fortune; counts are not modelled. */
  readonly chance: number;
  /** The tool the drop needs (`silk_touch`, `shears`, `shears or silk_touch`, an item); none for an ordinary break. */
  readonly tool?: string;
  /** The block state the drop needs, such as a crop's ripe `{ age: "7" }`. */
  readonly state?: Readonly<Record<string, string>>;
}
