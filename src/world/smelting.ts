/**
 * Furnace knowledge: the smelting recipes of each supported Minecraft version (generated from its server jar by
 * `smelting-extract.ts`, see `data/smelting/`) and the fuels a furnace burns.
 */
import recipes_1_21_4 from "./data/smelting/1.21.4.json" with { type: "json" };
import { itemTagsOf } from "./item-tags.js";
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

/** The ticks a furnace takes per item for the ordinary smelting recipes (the recipes' `cookingTicks`; blasting and smoking halve it). */
export const STANDARD_COOK_TICKS = 200;

/**
 * Burn times in ticks, copied from the game's Java code (`FuelValues`, 1.21.4): no data file holds them, only the item
 * tags that group the fuels (owner Q1, 2026-10-19: code-only facts named once). By item first, then by item tag; the
 * tag `non_flammable_wood` (the nether woods) burns nothing whatever its other tags say. An item in neither table
 * (furniture, wooden tools, banners, ...) is not offered as a fuel.
 */
const BURN_TICKS_BY_ITEM: Readonly<Record<string, number>> = {
  lava_bucket: 20_000, coal_block: 16_000, dried_kelp_block: 4_000, blaze_rod: 2_400, coal: 1_600, charcoal: 1_600,
  stick: 100, bowl: 100, dead_bush: 100, bamboo: 50, scaffolding: 50,
};
const BURN_TICKS_BY_TAG: Readonly<Record<string, number>> = {
  logs_that_burn: 300, bamboo_blocks: 300, planks: 300, wooden_stairs: 300, wooden_slabs: 150, wooden_trapdoors: 300,
  wooden_pressure_plates: 300, wooden_fences: 300, fence_gates: 300, boats: 1_200, signs: 200, hanging_signs: 800,
  wooden_doors: 200, wooden_buttons: 100, wool: 100, saplings: 100, wool_carpets: 67,
};
const NO_FUEL_TAG = "non_flammable_wood";

/**
 * How many items one of this fuel smelts when each takes `cookingTicks`; 0 means not a fuel in `version`. A version with
 * no shipped item tags knows only the fuels named by item.
 */
export function fuelCapacity(name: string, version: string, cookingTicks = STANDARD_COOK_TICKS): number {
  return burnTicks(name, version) / cookingTicks;
}

function burnTicks(name: string, version: string): number {
  const named = BURN_TICKS_BY_ITEM[name];
  if (named !== undefined) return named;
  const tags = itemTagsOf(name, version);
  if (tags.includes(NO_FUEL_TAG)) return 0;
  return Math.max(0, ...tags.map((tag) => BURN_TICKS_BY_TAG[tag] ?? 0));
}

/** The ticks the furnace takes to cook one `input` item in `version`, from its recipe; null when no recipe takes it. */
export function cookingTicksOf(input: string, version: string): number | null {
  return smeltingData(version)?.recipes.find((recipe) => recipe.inputs.includes(input))?.cookingTicks ?? null;
}

/** Every item of the registry's names that burns in `version`, with the items it smelts, sorted by name. */
export function fuelsOf(itemNames: Iterable<string>, version: string): { item: string; itemsSmelted: number }[] {
  return [...itemNames].sort().map((item) => ({ item, itemsSmelted: fuelCapacity(item, version) })).filter(({ itemsSmelted }) => itemsSmelted > 0);
}
