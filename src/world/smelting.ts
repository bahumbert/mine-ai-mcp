/**
 * Furnace knowledge: the smelting recipes of each supported Minecraft version (generated from its server jar by
 * `smelting-extract.ts`, see `data/smelting/`) and the fuels a furnace burns.
 */
import recipes_1_21_4 from "./data/smelting/1.21.4.json" with { type: "json" };
import { nearestShipped } from "./shipped-data.js";

/** One furnace recipe: any one of `inputs` cooks into `count` of `output`. */
export interface SmeltingRecipe {
  readonly output: string;
  readonly count: number;
  /** Item ids, any one of which works, in the game's own order (a tag's order). */
  readonly inputs: readonly string[];
  readonly cookingTicks: number;
}

interface SmeltingData {
  readonly version: string;
  readonly recipes: readonly SmeltingRecipe[];
}

/** Shipped data files, by version. Add a file with `smelting-extract.ts`, then list it here. */
const SHIPPED: readonly SmeltingData[] = [recipes_1_21_4];

/**
 * The smelting recipes for `version`: its own file, else the nearest older shipped one (recipes rarely change between
 * patch versions), else null when every shipped file is newer.
 */
export function smeltingData(version: string, shipped: readonly SmeltingData[] = SHIPPED): SmeltingData | null {
  return nearestShipped(version, shipped);
}

/** The recipes that make `item` in `version` (empty when none, or no data for that version). */
export function recipesFor(item: string, version: string): readonly SmeltingRecipe[] {
  return smeltingData(version)?.recipes.filter((recipe) => recipe.output === item) ?? [];
}

/**
 * How many items one of this fuel smelts. The game hard-codes burn times in its Java code (they are not data), so
 * this table is copied from it; 0 means not a fuel.
 */
export function fuelCapacity(name: string): number {
  if (name === "coal" || name === "charcoal") return 8;
  if (name === "coal_block") return 80;
  if (name === "dried_kelp_block") return 20;
  if (name === "blaze_rod") return 12;
  // Nether wood (crimson, warped) does not burn.
  if (name.startsWith("crimson_") || name.startsWith("warped_")) return 0;
  if (name.endsWith("_planks") || name.endsWith("_log") || name.endsWith("_wood")) return 1.5;
  if (name === "stick") return 0.5;
  return 0;
}

/** Fuels with a fixed name, for listing; planks, logs and wood of every kind also burn (1.5 items each). */
export const NAMED_FUELS = ["coal", "charcoal", "coal_block", "dried_kelp_block", "blaze_rod", "stick"] as const;
