/**
 * What mobs drop: each supported version's entity loot tables (generated from its server jar by `mob-drops-extract.ts`,
 * see `data/mob-drops/`), and which mobs an item is hunted from.
 */
import drops_1_21_4 from "./data/mob-drops/1.21.4.json" with { type: "json" };
import { spawnsIn } from "./mob-spawns.js";
import { nearestShipped } from "./shipped-data.js";
import { withSimilar } from "./similar-names.js";

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

/** One mob an item is hunted from, with where it can be found from the bot's position. */
export interface RankedMobSource extends MobSource {
  /** The mob spawns naturally in some biome of the bot's dimension (false when the dimension is unknown). */
  readonly spawnsInDimension: boolean;
  /** How many of that mob are loaded now. */
  readonly loaded: number;
}

/**
 * The mobs that drop `item`, best first for a hunt from `dimension`: some loaded nearby, then spawning naturally in
 * this dimension (worldgen biome spawners), then the likelier drop, then by name. `loadedCount` counts a mob's loaded entities.
 */
export function rankedMobSources(item: string, version: string, dimension: string | undefined, loadedCount: (mob: string) => number): readonly RankedMobSource[] {
  return mobSourcesOf(item, version)
    .map((source) => ({ ...source, spawnsInDimension: spawnsIn(source.mob, dimension, version), loaded: loadedCount(source.mob) }))
    .sort((a, b) =>
      Number(b.loaded > 0) - Number(a.loaded > 0) ||
      Number(b.spawnsInDimension) - Number(a.spawnsInDimension) ||
      b.chance - a.chance ||
      a.mob.localeCompare(b.mob));
}

/**
 * "cow is a mob, not an item: it drops beef, leather (get_items beef hunts it)" when `name` is an entity id (what a model
 * asks for when it wants the food a cow gives), else null. Drops come from the mob loot tables, likeliest first.
 */
export function mobNotItemAnswer(name: string, entitiesByName: Readonly<Record<string, unknown>>, version: string): string | null {
  if (entitiesByName[name] === undefined) return null;
  const drops = [...(mobDropsData(version)?.mobs[name] ?? [])].sort((a, b) => b.chance - a.chance || a.item.localeCompare(b.item));
  if (drops.length === 0) return `${name} is a mob, not an item`;
  return `${name} is a mob, not an item: it drops ${drops.map((drop) => drop.item).join(", ")} (get_items ${drops[0]!.item} hunts it)`;
}

/** What to tell about an item id the registry does not know: the mob it names and what that drops, else its closest ids ("raw_beef (closest: beef, cooked_beef)"). */
export function unknownItemAnswer(name: string, names: Iterable<string>, entitiesByName: Readonly<Record<string, unknown>>, version: string): string {
  return mobNotItemAnswer(name, entitiesByName, version) ?? withSimilar(name, names);
}
