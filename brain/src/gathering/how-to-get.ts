// How an item is obtained, from the runtime's game data: crafted, smelted, grown, broken from a block or hunted.
import type { BotRuntime, MobSource, SmeltingRecipe } from "../runtime-client.ts";
import { carried } from "./stacks.ts";

/** A drop this unlikely per break (apple from leaves, 0.5%) is rare: a fetch of it is bounded, and says the drop is rare. */
const RARE_DROP_CHANCE = 0.1;
/**
 * Blocks one fetch breaks for a rare drop without gaining it before it stops (live run 12, 2026-10-14: apples from
 * leaves took Sana 23 and 21 minutes, Mira 15). The brain decides what to do instead.
 */
export const RARE_DROP_BREAKS = 64;

/** How an item is obtained, learnt once per gathering from the runtime's game data. */
export interface Knowledge {
  readonly craftable: Map<string, boolean>;
  readonly smelted: Map<string, readonly SmeltingRecipe[]>;
  /** Items one of each fuel smelts (filled by the first furnace lookup). */
  fuels: Readonly<Record<string, number>>;
  /** Per block, the tools without which it drops nothing, cheapest first (game data); null when a hand will do. */
  readonly harvest: Map<string, readonly string[] | null>;
  /** Per block, the tool class it is mined with (game data: `shovel` for dirt); null when no tool helps. */
  readonly toolClass: Map<string, string | null>;
  /**
   * Tool classes whose tool broke during this gathering (the runtime's structured `toolLost`), and no other of the class
   * is carried yet: a block of that class gets another before it is dug, though it drops by hand (run 13: a shovel).
   */
  readonly lost: Set<string>;
  /** Per tool class, how many times its tool broke in this gathering (a tool that keeps dying ends the step). */
  readonly losses: Map<string, number>;
  /** Per gathered item, the block collect_block breaks for it (game data: cobblestone from stone); null when none drops it. */
  readonly source: Map<string, string | null>;
  /** Per item, the mob hunted for it (game data: white wool from sheep), passive ones first; null when none drops it. */
  readonly mob: Map<string, MobSource | null>;
  /** Items that only come from crops someone grows (wheat): a farm, not gathering, gets them. */
  readonly cropOnly: Set<string>;
  /** Nearby woods, open logs first then other hits, nearest within each group; looked up once for any-wood recipes. */
  woods: readonly string[] | null;
  /** Per block fetched for a rare drop, what it is fetched for and the breaks so far without gaining it. */
  readonly rare: Map<string, RareFetch>;
}

interface RareFetch {
  readonly item: string;
  readonly chance: number;
  readonly blocks: readonly string[];
  /** Blocks broken for it since it was last gained. */
  broken: number;
  /** How many of the item were carried when `broken` started (-1: not looked yet). */
  had: number;
}

/** "rare (0.5% of breaks)": how a rare drop is told. */
export function rareNote(chance: number): string {
  return `rare (${Math.round(chance * 1000) / 10}% of breaks)`;
}

/**
 * Where a block-only item comes from, in words, for a refusal that sends the model to get_items: "apple drops from
 * oak_leaves, dark_oak_leaves, and the drop is rare (0.5% of breaks)"; null when no block drops it.
 */
export async function dropSourcesNote(runtime: BotRuntime, item: string): Promise<string | null> {
  const sources = ((await runtime.blockSources([item]).catch(() => ({})))[item] ?? []).filter((source) => !source.planted && source.block !== item);
  if (sources.length === 0) return null;
  const rare = sources[0]!.chance < RARE_DROP_CHANCE ? `, and the drop is ${rareNote(sources[0]!.chance)}` : "";
  return `${item} drops from ${sources.map((source) => source.block).join(", ")}${rare}`;
}

/** `lost`: the tool classes broken earlier in the objective, shared with the next gathering of it. */
export function newKnowledge(lost: Set<string> = new Set()): Knowledge {
  return { craftable: new Map(), smelted: new Map(), fuels: {}, harvest: new Map(), toolClass: new Map(), lost, losses: new Map(), source: new Map(), mob: new Map(), cropOnly: new Set(), woods: null, rare: new Map() };
}

/** How a player gets an item, as `get_items` would: crafted, smelted, grown on a farm, broken from `block`, or hunted. */
type ObtainedBy =
  | { readonly way: "craft" | "smelt" | "farm" | "none" }
  | { readonly way: "gather"; readonly block: string }
  | { readonly way: "hunt"; readonly mob: string };

/** How `get_items` would get `item` (the runtime's game data: recipes, furnace recipes, loot tables). */
export async function obtainedBy(runtime: BotRuntime, item: string): Promise<ObtainedBy> {
  const knowledge = newKnowledge();
  const how = await howToGet(runtime, item, knowledge);
  if (how === null) return { way: "none" };
  if (how !== "gather") return { way: how };
  const from = await gatherFrom(runtime, item, knowledge);
  if (from !== null) return "mob" in from ? { way: "hunt", mob: from.mob } : { way: "gather", block: from.block };
  return { way: knowledge.cropOnly.has(item) ? "farm" : "none" };
}

/** Woods loaded around her, looked at for the nearest logs of any kind. */
const WOOD_SCAN = 48;

/**
 * Loaded logs, open hits first then other hits, nearest within each group, once per gathering for wooden crafts.
 * Carrying no wood, the crafting planner otherwise named the first wood in registry order (live 2026-10-03: Vex walked
 * 900 blocks, across an ocean, for pale oak, with oak and birch all around).
 */
export async function nearbyWoods(runtime: BotRuntime, knowledge: Knowledge): Promise<readonly string[]> {
  if (knowledge.woods === null) {
    const found = await runtime.findBlocks("logs", WOOD_SCAN);
    knowledge.woods = [...new Set([...found.filter((block) => block.situation === undefined), ...found].map((block) => block.name))];
  }
  return knowledge.woods;
}

/** How `item` is obtained: crafted, smelted (with its recipes), or gathered as it is; null when it is no item. */
export async function howToGet(runtime: BotRuntime, item: string, knowledge: Knowledge): Promise<"craft" | "smelt" | "gather" | null> {
  let craftable = knowledge.craftable.get(item);
  if (craftable === undefined) {
    const needs = await runtime.craftingNeeds([{ item, count: 1 }]);
    if (needs.status === "unknown") return null;
    // A recipe the planner cannot turn into a plan is no way to get it: coal and iron ingots only craft back out of
    // their own storage blocks (live 2026-10-02: "cannot work out how to craft 1 coal").
    craftable = needs.status === "ready" || needs.status === "missing_materials";
    knowledge.craftable.set(item, craftable);
  }
  // What an animal gives for sure is taken from it, as a player would, not crafted the long way (live 2026-10-04: a
  // bed's wool planned from string, 4 string a wool; a fight or a rare drop is no such source: arrows are crafted).
  if (craftable) return (await huntedFrom(runtime, item, knowledge))?.hostile === false ? "gather" : "craft";
  let recipes = knowledge.smelted.get(item);
  if (recipes === undefined) {
    const smelting = await runtime.smeltingRecipes([item]);
    // Ore blocks only cook into what mining them drops (coal, diamond…): a player mines those, it smelts raw iron.
    recipes = (smelting.recipes[item] ?? []).filter((recipe) => recipe.inputs.some((input) => !isOre(input)));
    if (Object.keys(smelting.fuels).length > 0) knowledge.fuels = smelting.fuels;
    knowledge.smelted.set(item, recipes);
  }
  return recipes.length > 0 ? "smelt" : "gather";
}

/** Why `item` is no item id, in the runtime's words: they name the registry ids close to it ("sticks": stick). */
export async function unknownItem(runtime: BotRuntime, item: string): Promise<string> {
  return (await runtime.craftingNeeds([{ item, count: 1 }])).error ?? `${item} is not a Minecraft item id`;
}

/**
 * Where the first one of a crop that is its own seed (carrot, potato) comes from, in the game's data: no wild block
 * drops it, a farm plants the ones carried, so a mob's drop or a find starts the farm. Null for any other item (a
 * crop with a seed of its own, or a wild source, is fetched or farmed as usual).
 */
export async function firstOfOwnSeed(runtime: BotRuntime, item: string): Promise<string | null> {
  const sources = (await runtime.blockSources([item]).catch(() => ({})))[item] ?? [];
  if (sources.some((source) => !source.planted) || !sources.some((source) => source.planted && source.seed === item)) return null;
  const mobs = ((await runtime.mobSources([item]).catch(() => ({})))[item] ?? []).slice().sort((a, b) => Number(a.hostile) - Number(b.hostile) || b.chance - a.chance);
  const first = mobs[0];
  const from = first === undefined
    ? "no mob drops it"
    : `a ${first.mob} drops it ${(first.chance * 100).toFixed(1)}% of the time (hunt ${first.mob} for ${item}${mobs.length > 1 ? `; others: ${mobs.slice(1).map((mob) => mob.mob).join(", ")}` : ""})`;
  return `${item} is its own seed, so no block gives it and a farm plants the ones you carry (one per cell): a first one comes from ${from}, or a chest, a village or another player; with one in hand, farm ${item}`;
}

export async function notDropped(runtime: BotRuntime, item: string, knowledge: Knowledge): Promise<string> {
  // A farm's crops are someone's work, and routes never break them: gathering would only fail at them.
  if (knowledge.cropOnly.has(item)) {
    const first = await firstOfOwnSeed(runtime, item);
    return `${item} grows as a crop: ${first ?? "farm it (harvest a farm of yours, or make one), then use it"}`;
  }
  // A block that drops something else is asked for by its drop (live 2026-10-07: Vex asked for iron_ore, which drops
  // raw_iron without silk touch).
  const known: Readonly<Record<string, readonly string[]>> = await runtime.blockDrops([item]).catch(() => ({}));
  const drops = (known[item] ?? []).filter((drop) => drop !== item);
  if (drops.length > 0) return `${item} is never got as itself: broken, it drops ${drops.join(", ")}; get_items ${drops[0]}`;
  return `no block or mob drops ${item}, and it is not crafted or smelted`;
}

/** A drop this likely, or more, makes a mob a source to hunt (cod drop bone meal 5% of the time: no source). */
const HUNT_CHANCE = 0.5;

/** The mobs worth hunting for `item`, in the runtime's preference order (loaded, spawns here, chance, name). */
export async function huntSources(runtime: BotRuntime, item: string): Promise<readonly MobSource[]> {
  return ((await runtime.mobSources([item]).catch(() => ({})))[item] ?? []).filter((source) => source.chance >= HUNT_CHANCE);
}

/** The mob to hunt for `item` (game data): the first non-hostile source, else the first; null when none. */
async function huntedFrom(runtime: BotRuntime, item: string, knowledge: Knowledge): Promise<MobSource | null> {
  const known = knowledge.mob.get(item);
  if (known !== undefined) return known;
  const sources = await huntSources(runtime, item);
  const mob = sources.find((source) => !source.hostile) ?? sources[0] ?? null;
  knowledge.mob.set(item, mob);
  return mob;
}

/**
 * Where `item` is gathered: the block to break for it, else the mob to hunt; a block that only drops itself (a wool block
 * someone placed) comes after a mob that drops it. Null when neither.
 */
export async function gatherFrom(runtime: BotRuntime, item: string, knowledge: Knowledge): Promise<{ readonly block: string } | { readonly mob: string } | null> {
  const block = await sourceBlock(runtime, item, knowledge);
  const mob = await huntedFrom(runtime, item, knowledge);
  if (block !== null && (block !== item || mob === null)) return { block };
  if (mob !== null) {
    // Not a crop after all: an animal gives it.
    knowledge.cropOnly.delete(item);
    return { mob: mob.mob };
  }
  return null;
}

/**
 * The block to break for `item`, from the game's loot tables (`view_block_drops`): a wild block before a crop someone
 * planted (grass, not a farm's wheat, for seeds), the likeliest drop first, and among equally likely ones the nearest
 * loaded (fern beside her rather than grass far off); null when no block drops it.
 */
async function sourceBlock(runtime: BotRuntime, item: string, knowledge: Knowledge): Promise<string | null> {
  const known = knowledge.source.get(item);
  if (known !== undefined) return known;
  const sources = (await runtime.blockSources([item]))[item] ?? [];
  const wild = sources.filter((source) => !source.planted);
  if (wild.length === 0 && sources.length > 0) {
    knowledge.cropOnly.add(item);
    knowledge.source.set(item, null);
    return null;
  }
  const pool = wild;
  const tied = pool.filter((source) => source.chance === pool[0]?.chance).map((source) => source.block);
  let block = tied[0] ?? null;
  if (tied.length > 1) {
    const at = (await runtime.status()).position;
    let nearest = Number.POSITIVE_INFINITY;
    for (const candidate of tied) {
      const entries = await runtime.findBlocks(candidate, 8);
      const found = entries.find((entry) => entry.situation === undefined) ?? entries[0];
      const distance = found === undefined ? Number.POSITIVE_INFINITY : Math.hypot(found.x - at.x, found.y - at.y, found.z - at.z);
      if (distance < nearest) [nearest, block] = [distance, candidate];
    }
  }
  knowledge.source.set(item, block);
  const chosen = pool.find((source) => source.block === block);
  if (block !== null && block !== item && chosen !== undefined && chosen.chance < RARE_DROP_CHANCE) {
    // `had` starts at what she carries now, so the first check already sees a gain.
    const had = carried((await runtime.status()).inventory, item);
    knowledge.rare.set(block, { item, chance: chosen.chance, blocks: pool.filter((source) => source.chance === chosen.chance).map((source) => source.block), broken: 0, had });
  }
  return block;
}

/** An ore block: it drops its own item (raw iron, coal…), it is smelted whole only when silk-touched. */
export function isOre(item: string): boolean {
  return item.endsWith("_ore");
}
