/**
 * Where mobs spawn naturally: each supported version's biome spawner lists (generated from its server jar by
 * `mob-spawns-extract.ts`, see `data/mob-spawns/`) joined with minecraft-data's dimension of each biome.
 */
import minecraftData from "minecraft-data";
import spawns_1_21_4 from "./data/mob-spawns/1.21.4.json" with { type: "json" };
import { nearestShipped } from "./shipped-data.js";

interface MobSpawnsData {
  readonly version: string;
  readonly biomes: Readonly<Record<string, readonly string[]>>;
}

/** Shipped data files, by version. Add a file with `mob-spawns-extract.ts`, then list it here. */
const SHIPPED: readonly MobSpawnsData[] = [spawns_1_21_4];

/** minecraft-data names the dimensions of its biomes `overworld`, `nether`, `end`; the game's are `the_nether`, `the_end`. */
function biomeDimensionName(dimension: string): string {
  return dimension.replace(/^minecraft:/u, "").replace(/^the_/u, "");
}

const dimensionMobs = new Map<string, ReadonlySet<string>>();

/** Every mob some biome of `dimension` spawns, for `version` (cached). */
function mobsSpawningIn(dimension: string, version: string): ReadonlySet<string> {
  const data = nearestShipped(version, SHIPPED);
  if (data === null) return new Set();
  const key = `${data.version}/${version}/${dimension}`;
  let mobs = dimensionMobs.get(key);
  if (mobs === undefined) {
    const biomeDimensions = minecraftData(version)?.biomesByName ?? {};
    mobs = new Set(Object.entries(data.biomes)
      .filter(([biome]) => biomeDimensions[biome]?.dimension === dimension)
      .flatMap(([, list]) => list));
    dimensionMobs.set(key, mobs);
  }
  return mobs;
}

/** Whether `mob` spawns naturally in some biome of the bot's `dimension` (`overworld`, `the_nether`, `the_end`); false when there is no data or no dimension. */
export function spawnsIn(mob: string, dimension: string | undefined, version: string): boolean {
  return dimension !== undefined && mobsSpawningIn(biomeDimensionName(dimension), version).has(mob);
}
