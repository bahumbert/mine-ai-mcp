/**
 * What mobs drop: each supported version's entity loot tables (generated from its server jar by `mob-drops-extract.ts`,
 * see `data/mob-drops/`), and which mobs an item is hunted from.
 */
import drops_1_21_4 from "./data/mob-drops/1.21.4.json" with { type: "json" };
import { nearestShipped } from "./shipped-data.js";

/** One item a mob can drop, at its best chance (no looting, conditions on the kill left out). */
export interface MobDrop {
  readonly item: string;
  readonly chance: number;
}

interface MobDropsData {
  readonly version: string;
  readonly mobs: Readonly<Record<string, readonly MobDrop[]>>;
}

/** Shipped data files, by version. Add a file with `mob-drops-extract.ts`, then list it here. */
const SHIPPED: readonly MobDropsData[] = [drops_1_21_4];

/** One mob an item is hunted from. */
export interface MobSource {
  readonly mob: string;
  readonly chance: number;
}

/** The mob drops for `version` (see `nearestShipped`), else null. */
export function mobDropsData(version: string): MobDropsData | null {
  return nearestShipped(version, SHIPPED);
}

/** The mobs that drop `item`, likeliest first, then by name. */
export function mobSourcesOf(item: string, version: string): readonly MobSource[] {
  const mobs = mobDropsData(version)?.mobs ?? {};
  const sources: MobSource[] = [];
  for (const [mob, drops] of Object.entries(mobs)) {
    const drop = drops.find((candidate) => candidate.item === item);
    if (drop !== undefined) sources.push({ mob, chance: drop.chance });
  }
  return sources.sort((a, b) => b.chance - a.chance || a.mob.localeCompare(b.mob));
}
