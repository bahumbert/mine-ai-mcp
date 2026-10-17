import { z } from "zod";
import { describeMaterials, shortfall } from "./building/blueprint.ts";
import { toolToMake } from "./building/tool-loss.ts";
import { boatsOfWood } from "./boats.ts";
import type { ActOutcome, Body } from "./body.ts";
import { consumedBy, FULL_INVENTORY } from "./inventory-room.ts";
import { errorCode, type BotRuntime, type FoundBlock, type ItemCount, type MobSource, type Position, type SeenBlock, type SmeltingRecipe } from "./runtime-client.ts";

/** The runtime's `collect_block` limit per call (src/actions/collect-block/contract.ts `MAX_COLLECT_BLOCKS`). */
const MAX_COLLECT = 32;
/**
 * How far (horizontally) a fetch goes for what it gathers, from where each collect starts (spec 2026-10-03
 * fetch-range): never a trip by itself (live 2026-10-03: unbounded, a fetch for a scarce wood walked 900 blocks across
 * an ocean). Farther is a decision of the model: a `go_to` of its own.
 */
export const FETCH_RANGE = 64;
/** The runtime's `smelt_item` limit per call: one furnace input slot. */
const MAX_SMELT = 64;
/** Gather/craft/smelt rounds before giving up; a house takes about five (logs, table, pickaxe, stone, crafting),
 * replacing what crafting used up of the kept items (fences eat planks, planks eat logs) a few more, and glass panes
 * about ten (sand, logs, table, pickaxe, stone, furnace and fuel, glass, panes). */
const MAX_ROUNDS = 24;
/** A drop this unlikely per break (apple from leaves, 0.5%) is rare: a fetch of it is bounded, and says the drop is rare. */
export const RARE_DROP_CHANCE = 0.1;
/**
 * Blocks one fetch breaks for a rare drop without gaining it before it stops (live run 12, 2026-10-14: apples from
 * leaves took Sana 23 and 21 minutes, Mira 15). The brain decides what to do instead.
 */
export const RARE_DROP_BREAKS = 64;
/** Farther than this from home, the bot walks back before setting its crafting table or furnace down. */
const HOME_RANGE = 3;
/** Fuel made when none is carried: planks of the wood it carries, else these. */
const DEFAULT_FUEL = "oak_planks";

export interface GatherContext {
  readonly runtime: BotRuntime;
  readonly body: Body;
  readonly signal: AbortSignal;
  /**
   * Told what it starts doing now and what for, at each phase change (gathering, crafting, smelting), so the character
   * can say it (owner, 2026-10-02: under an order, she says what she does and why).
   */
  readonly progress?: (fact: string) => void;
  /** Told where a fetch is travelling to (a place it saw the block), and null when it arrived or gave up: getting nearer counts as progress for the no-gain stop. */
  readonly heading?: (target: { readonly x: number; readonly z: number } | null) => void;
  /** Drops what the work does not need to free a slot, never the `inputs` of the craft or smelt in hand; true when a slot is free now (unset: nothing is dropped unasked). */
  readonly makeRoom?: (inputs: ReadonlySet<string>) => Promise<boolean>;
}

export type GatherResult =
  | { readonly status: "done"; readonly detail: string }
  | { readonly status: "failed"; readonly detail: string }
  | { readonly status: "stopped" };

/** One furnace job: `count` of `output` from `input`, burning `fuel`. */
interface SmeltJob {
  readonly output: string;
  readonly count: number;
  readonly input: string;
  readonly fuel: string;
  /** Fuel items the whole job burns. */
  readonly fuelCount: number;
  /** Items one fuel item smelts. */
  readonly fuelWorth: number;
}

/** One round's work: what to collect (block → drops wanted), which tools are still to craft, what to craft or smelt. */
interface Round {
  readonly collect: ReadonlyMap<string, number>;
  /** What to hunt: item → the mob that drops it and how many. */
  readonly hunt: ReadonlyMap<string, { readonly mob: string; readonly count: number }>;
  readonly tableFirst: boolean;
  /** The harvest tool to craft before some block to collect drops anything (a wooden pickaxe for stone). */
  readonly toolFirst: string | null;
  readonly craft: readonly ItemCount[];
  readonly smelt: readonly SmeltJob[];
}

const TABLE = { item: "crafting_table", count: 1 } as const;
const FURNACE = "furnace";

/** How an item is obtained, learnt once per gathering from the runtime's game data. */
interface Knowledge {
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
  /** Per gathered item, the block collect_block breaks for it (game data: cobblestone from stone); null when none drops it. */
  readonly source: Map<string, string | null>;
  /** Per item, the mob hunted for it (game data: white wool from sheep), passive ones first; null when none drops it. */
  readonly mob: Map<string, MobSource | null>;
  /** Items that only come from crops someone grows (wheat): a farm, not gathering, gets them. */
  readonly cropOnly: Set<string>;
  /** The woods growing nearby, nearest first, looked up once: recipes that take any wood are planned with them. */
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

/**
 * Gets every item of `bill` into the inventory the way a player would: chop and dig the raw materials, craft a
 * crafting table to carry and the cheapest tool a block needs to drop anything (game data: a wooden pickaxe for
 * stone, a stone one for iron ore, made from the stone it digs first), smelt in a carried furnace what only a furnace
 * makes (glass from sand: input, fuel and the furnace itself are gathered or crafted first), then craft the rest
 * (the table and furnace are set down and picked up again). The runtime's crafting planner and its furnace recipes
 * (game data) pick the recipes; each round starts again from the real inventory, so a recipe that used another wood
 * than planned only costs another round. Crafting and smelting happen back at `home` (the build site: open ground),
 * never at the bottom of the shaft the stone came from.
 *
 * `keep`: what the character carried before and still wants afterwards. A craft that uses some of it up (the fences
 * asked for eat the planks it carried for the walls) adds it back to what is gathered, so fetching a few items never
 * leaves it short of the others. Not a smelt: carried raw iron is there to be smelted and coal to be burnt (fuel
 * burnt from the asked-for items themselves is made again like any shortfall). Food eaten or a tool worn out on the
 * way is not replaced.
 *
 * What it fetches is not scaffolding meanwhile (see {@link withMaterialsKept}).
 */
export async function gatherMaterials(
  context: GatherContext,
  bill: readonly ItemCount[],
  purpose: string,
  home: Position,
  keep: readonly ItemCount[] = [],
): Promise<GatherResult> {
  const knowledge = newKnowledge();
  const kept = await madeItems(context.runtime, keep, knowledge);
  const items = [...bill, ...kept].map((entry) => entry.item);
  return withMaterialsKept(context.runtime, items, () => gatherRounds(context, bill, purpose, home, kept, knowledge));
}

/**
 * Materials being fetched are not scaffolding (live 2026-10-04: walking out of a cave, Tom's routes used 16 of the 36
 * cobblestone fetched for his house, and the build was short again): while `run` runs, those of `items` on the
 * runtime's scaffold list are taken off it, and the list is put back after (owner, 2026-10-07).
 */
export async function withMaterialsKept<T>(runtime: BotRuntime, items: readonly string[], run: () => Promise<T>): Promise<T> {
  const policy = (await runtime.status()).policy;
  const scaffold = policy?.scaffoldBlocks ?? [];
  const kept = scaffold.filter((block) => items.includes(block));
  if (policy === null || kept.length === 0) return run();
  if (!(await runtime.setScaffoldBlocks(scaffold.filter((block) => !kept.includes(block)), policy.revision).catch(() => false))) return run();
  try {
    return await run();
  } finally {
    // A death wipes policies (the list is back to its defaults then): putting the old one back is harmless.
    const now = (await runtime.status().catch(() => null))?.policy;
    if (now != null) await runtime.setScaffoldBlocks(scaffold, now.revision).catch(() => false);
  }
}

// Raw materials she carries are what crafting uses, as a player's would: only what was made (planks, stairs, glass)
// is kept from the crafts (live 2026-10-04: Tom's 24 logs, gathered for his house, were "used up" by its planks and
// gathered again 24 rounds in a row; the furnace was planned from deepslate past his 20 cobblestone). An item the
// game data does not know (a modded one, named "unknown") cannot be made again either (live 2026-10-07: "unknown is
// not a Minecraft item id").
async function madeItems(runtime: BotRuntime, keep: readonly ItemCount[], knowledge: Knowledge): Promise<ItemCount[]> {
  return (await Promise.all(keep.map(async (entry) => {
    const how = await howToGet(runtime, entry.item, knowledge);
    return how === null || how === "gather" ? null : entry;
  })))
    .filter((entry): entry is ItemCount => entry !== null);
}

/** The one step of a round (or why there is none): collect, hunt, make a table or tool, craft or smelt, whichever the plan puts first. */
async function roundStep(
  context: GatherContext,
  plan: Round,
  inventory: Stacks,
  missing: readonly ItemCount[],
  purpose: string,
  site: Site,
  knowledge: Knowledge,
  spent: Spent,
): Promise<GatherResult | string> {
  const ungated = [...plan.collect].filter(([block]) => toolMissing(block, inventory, knowledge) === null);
  const gated = [...plan.collect].filter(([block]) => toolMissing(block, inventory, knowledge) !== null);
  if (ungated.length > 0) return collectAll(context, ungated, purpose, knowledge);
  if (plan.hunt.size > 0) return huntAll(context, plan.hunt, purpose, knowledge);
  if (plan.tableFirst) return craft(context, [TABLE], purpose, false, spent);
  if (plan.toolFirst !== null) return craftAtHome(context, [{ item: plan.toolFirst, count: 1 }], purpose, site, spent);
  if (gated.length > 0) return collectAll(context, gated, purpose, knowledge);
  const ready = await readyCrafts(context.runtime, plan.craft);
  const job = plan.smelt.find((candidate) => smeltReady(candidate, inventory));
  if (ready.length > 0) return craftAtHome(context, ready, purpose, site, spent);
  if (job !== undefined) return smeltAtHome(context, job, purpose, site);
  return `cannot work out how to get ${describeMaterials(missing)}: nothing left to gather, craft or smelt`;
}

async function gatherRounds(
  context: GatherContext,
  bill: readonly ItemCount[],
  purpose: string,
  home: Position,
  keep: readonly ItemCount[],
  knowledge: Knowledge,
): Promise<GatherResult> {
  const site: Site = { home };
  const actions: string[] = [];
  /** Her own items a craft used and that were not replaced, none being near. */
  const usedOwn: ItemCount[] = [];
  const finish = (detail: string): GatherResult => ({
    status: "done",
    detail: usedOwn.length === 0 ? detail : `${detail}; used ${describeMaterials(usedOwn)} of what you carried (none near to replace it)`,
  });
  let wanted = [...bill];
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const inventory = (await context.runtime.status()).inventory;
    const missing = shortfall(wanted, inventory);
    if (missing.length === 0) return finish(actions.length === 0 ? "had everything" : actions.join(", "));
    // A full bucket is no drop and no craft: a bucket (made like any item) filled at the liquid.
    const liquids = await context.runtime.toolEnum("use_bucket", "liquid");
    const filling = missing.find((entry) => bucketLiquid(entry.item, liquids) !== null);
    if (filling !== undefined && carried(inventory, "bucket") > 0) {
      const liquid = bucketLiquid(filling.item, liquids)!;
      context.progress?.(`filling a bucket with ${liquid}, for ${purpose}`);
      const filled = await act(context, "use_bucket", { action: "fill", liquid }, `Fill a bucket with ${liquid}, for ${purpose}.`);
      if (filled !== null) return filled.status === "failed" && actions.length > 0 ? { status: "failed", detail: `got ${actions.join(", ")} so far; ${filled.detail}` } : filled;
      actions.push(`filled a bucket with ${liquid}`);
      continue;
    }
    const plan = await planRound(context.runtime, missing.map((entry) => entry === filling ? { item: "bucket", count: entry.count } : entry), inventory, knowledge);
    if (typeof plan === "string") return { status: "failed", detail: plan };

    // Only the craft itself counts as using kept items up: dirt spent as scaffold on the walk back home
    // is not fetched again (observed live 2026-10-01: a detour to collect 11 dirt).
    const spent: Spent = (before, after) => {
      wanted = keepWhatCraftingUsed(wanted, keep, before, after);
    };
    const stepped = await roundStep(context, plan, inventory, missing, purpose, site, knowledge, spent);
    if (typeof stepped === "string") return { status: "failed", detail: stepped };
    const step = stepped;
    if (step.status === "stopped") return step;
    // A broken tool is replaced once: if the replacement cannot be made, the work goes on without it (a hand digs dirt).
    const remade = plan.toolFirst === null ? null : plan.toolFirst.split("_").at(-1)!;
    if (remade !== null && knowledge.lost.delete(remade) && step.status === "failed") {
      // A block that drops nothing without the tool cannot go on without it: the gather ends here, not a round later.
      const now = (await context.runtime.status()).inventory;
      if ([...plan.collect.keys()].some((block) => requiresTool(block, now, knowledge))) return step;
      actions.push(`setback (could not make another ${plan.toolFirst}: ${step.detail}); going on without it`);
      continue;
    }
    const fruitless = rareFruitless(knowledge, (await context.runtime.status()).inventory);
    if (fruitless !== null) return { status: "failed", detail: fruitless };
    // What a craft took from her own items is replaced only from what is near: when the replacement is out of range,
    // she goes on with what was asked for and says what she used (live 2026-10-03: a wooden pickaxe used one of Vex's
    // own dark oak logs, and replacing it walked 700 blocks; with the range, it ended the fetch instead).
    if (step.status === "failed" && /^no \S+ within /u.test(step.detail)) {
      const used = shortfall(keep, (await context.runtime.status()).inventory);
      if (used.length > 0 && wanted.some((entry) => !bill.some((asked) => asked.item === entry.item && asked.count >= entry.count))) {
        wanted = [...bill];
        usedOwn.push(...used);
        continue;
      }
    }
    if (step.status === "failed") {
      // A setback that still got something (a pickaxe that broke after 15 of 16 stones) or a fight that interrupted
      // the work is survival as usual: the next round sees what is missing now, a new pickaxe included. Failing
      // without progress for any other reason ends the gathering.
      const after = shortfall(wanted, (await context.runtime.status()).inventory);
      // A tool that broke on the way (live 2026-10-04: Tom underground, his pickaxe gone) is a setback too: the next
      // round goes on without it, or makes another.
      if (units(after) >= units(missing) && !["HOSTILE_CONTACT", "TOOL_TIER_LOST"].includes(errorCode(step.detail) ?? "")) {
        if (actions.length === 0) return step;
        // What the earlier rounds got is not lost with the last failure (live 2026-10-10: a fetch ended with only the
        // last place's failure, and no word of the logs already carried).
        const now = (await context.runtime.status()).inventory;
        const carriedNow = describeMaterials(bill.map((entry) => ({ item: entry.item, count: carried(now, entry.item) })).filter((entry) => entry.count > 0));
        return { status: "failed", detail: `got ${actions.join(", ")} so far (carried now: ${carriedNow === "" ? "none of it" : carriedNow}); still missing ${describeMaterials(shortfall(wanted, now))}: ${step.detail}` };
      }
      actions.push(`setback (${step.detail})`);
      continue;
    }
    actions.push(step.detail);
  }
  const left = shortfall(wanted, (await context.runtime.status()).inventory);
  return left.length === 0
    ? finish(actions.join(", "))
    : { status: "failed", detail: `still missing ${describeMaterials(left)} after ${MAX_ROUNDS} rounds of gathering` };
}

type Stacks = readonly { readonly name: string; readonly count: number }[];

function carried(inventory: Stacks, item: string): number {
  return inventory.filter((stack) => stack.name === item).reduce((sum, stack) => sum + stack.count, 0);
}

/** `wanted`, raised back to the kept count of every kept item a craft between `before` and `after` used up. */
function keepWhatCraftingUsed(wanted: readonly ItemCount[], keep: readonly ItemCount[], before: Stacks, after: Stacks): ItemCount[] {
  const next = [...wanted];
  for (const { item, count } of keep) {
    const now = carried(after, item);
    if (now >= carried(before, item) || now >= count) continue;
    const index = next.findIndex((entry) => entry.item === item);
    if (index < 0) next.push({ item, count });
    else if (next[index]!.count < count) next[index] = { item, count };
  }
  return next;
}

function units(items: readonly ItemCount[]): number {
  return items.reduce((sum, { count }) => sum + count, 0);
}

function newKnowledge(): Knowledge {
  return { craftable: new Map(), smelted: new Map(), fuels: {}, harvest: new Map(), toolClass: new Map(), lost: new Set(), source: new Map(), mob: new Map(), cropOnly: new Set(), woods: null, rare: new Map() };
}

/** How a player gets an item, as `get_items` would: crafted, smelted, grown on a farm, broken from `block`, or hunted. */
export type ObtainedBy =
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
 * The logs loaded nearby, nearest first, once per gathering: what a player chops for sticks, a table or wooden tools.
 * Carrying no wood, the crafting planner otherwise named the first wood in registry order (live 2026-10-03: Vex walked
 * 900 blocks, across an ocean, for pale oak, with oak and birch all around).
 */
async function nearbyWoods(runtime: BotRuntime, knowledge: Knowledge): Promise<readonly string[]> {
  knowledge.woods ??= [...new Set((await runtime.findBlocks("logs", WOOD_SCAN)).map((found) => found.name))];
  return knowledge.woods;
}

/** How `item` is obtained: crafted, smelted (with its recipes), or gathered as it is; null when it is no item. */
async function howToGet(runtime: BotRuntime, item: string, knowledge: Knowledge): Promise<"craft" | "smelt" | "gather" | null> {
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

/**
 * The liquid a full bucket `item` holds, among the `liquids` a `use_bucket` fill scoops (the contract's enum, read from
 * the runtime: a full bucket is named for its liquid); null for any other item (milk, powder snow, a fish...).
 */
function bucketLiquid(item: string, liquids: readonly string[]): string | null {
  return liquids.find((liquid) => item === `${liquid}_bucket`) ?? null;
}

/** Why `item` is no item id, in the runtime's words: they name the registry ids close to it ("sticks": stick). */
async function unknownItem(runtime: BotRuntime, item: string): Promise<string> {
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

async function notDropped(runtime: BotRuntime, item: string, knowledge: Knowledge): Promise<string> {
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

/** The mob to hunt for `item` (game data), a passive one before a hostile one, the likeliest first; null when none. */
async function huntedFrom(runtime: BotRuntime, item: string, knowledge: Knowledge): Promise<MobSource | null> {
  const known = knowledge.mob.get(item);
  if (known !== undefined) return known;
  const sources = ((await runtime.mobSources([item]).catch(() => ({})))[item] ?? []).filter((source) => source.chance >= HUNT_CHANCE);
  const mob = sources.find((source) => !source.hostile) ?? sources[0] ?? null;
  knowledge.mob.set(item, mob);
  return mob;
}

/**
 * Where `item` is gathered: the block to break for it, else the mob to hunt; a block that only drops itself (a wool block
 * someone placed) comes after a mob that drops it. Null when neither.
 */
async function gatherFrom(runtime: BotRuntime, item: string, knowledge: Knowledge): Promise<{ readonly block: string } | { readonly mob: string } | null> {
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
      const found = (await runtime.findBlocks(candidate, 1))[0];
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
function isOre(item: string): boolean {
  return item.endsWith("_ore");
}

/** The input a furnace job uses: the one it carries most of, else the game's first that is not an ore block. */
function chooseInput(recipes: readonly SmeltingRecipe[], inventory: Stacks): string {
  const inputs = recipes.flatMap((recipe) => recipe.inputs).filter((input) => !isOre(input));
  const best = [...inputs].sort((a, b) => carried(inventory, b) - carried(inventory, a))[0]!;
  return carried(inventory, best) > 0 ? best : inputs[0]!;
}

/**
 * The fuel for smelting `count` items, never the input itself: a fuel carried or being fetched anyway (`coming`) that
 * covers the job (the one burning the fewest items: coal before planks), else planks of the wood it carries, else oak
 * planks; with how many it burns.
 */
function chooseFuel(count: number, input: string, inventory: Stacks, coming: readonly ItemCount[], fuels: Readonly<Record<string, number>>): { fuel: string; fuelCount: number; fuelWorth: number } {
  const worth = (name: string) => (name === input ? 0 : fuels[name] ?? 0);
  const available = (name: string) => carried(inventory, name) + (coming.find((entry) => entry.item === name)?.count ?? 0);
  const covering = [...new Set([...inventory.map((stack) => stack.name), ...coming.map((entry) => entry.item)])]
    .filter((name) => worth(name) > 0 && available(name) * worth(name) >= count)
    .sort((a, b) => worth(b) - worth(a))[0];
  if (covering !== undefined) return { fuel: covering, fuelCount: Math.ceil(count / worth(covering)), fuelWorth: worth(covering) };
  const wood = inventory.map((stack) => /^(.+)_(planks|log)$/u.exec(stack.name)?.[1]).find((kind) => kind !== undefined && (fuels[`${kind}_planks`] ?? 0) > 0);
  const fuel = wood === undefined ? DEFAULT_FUEL : `${wood}_planks`;
  const fuelWorth = fuels[fuel] ?? 1.5;
  return { fuel, fuelCount: Math.ceil(count / fuelWorth), fuelWorth };
}

/** Whether it carries the furnace, the input and the fuel for the job's next furnace load. */
function smeltReady(job: SmeltJob, inventory: Stacks): boolean {
  const load = Math.min(job.count, MAX_SMELT);
  return carried(inventory, FURNACE) > 0 && carried(inventory, job.input) >= load && carried(inventory, job.fuel) >= Math.ceil(load / job.fuelWorth);
}

/**
 * The crafts of `items` it can do right now (every material carried), in one batch: all of them, else those that can
 * each be done (the furnace and the fuel planks, not yet the panes waiting for glass) when they fit together, else the
 * first of those.
 */
async function readyCrafts(runtime: BotRuntime, items: readonly ItemCount[]): Promise<readonly ItemCount[]> {
  if (items.length === 0) return [];
  if ((await runtime.craftingNeeds(items)).status === "ready") return items;
  const ready: ItemCount[] = [];
  for (const item of items) if ((await runtime.craftingNeeds([item])).status === "ready") ready.push(item);
  if (ready.length > 1 && (await runtime.craftingNeeds(ready)).status !== "ready") return ready.slice(0, 1);
  return ready;
}

/** What the next rounds need, or why it cannot be done. */
async function planRound(runtime: BotRuntime, missing: readonly ItemCount[], inventory: Stacks, knowledge: Knowledge): Promise<Round | string> {
  const collect = new Map<string, number>();
  const hunt = new Map<string, { mob: string; count: number }>();
  /** The gathered leaves of the crafts, worked out again on each pass as the crafts grow. */
  let leaves = new Map<string, number>();
  let huntedLeaves = new Map<string, { mob: string; count: number }>();
  const crafted = new Map<string, number>();
  const smelts = new Map<string, number>();
  const jobs = new Map<string, SmeltJob>();
  const gathered = async (item: string, count: number): Promise<string | null> => {
    const from = await gatherFrom(runtime, item, knowledge);
    if (from === null) return notDropped(runtime, item, knowledge);
    if ("mob" in from) hunt.set(item, { mob: from.mob, count: (hunt.get(item)?.count ?? 0) + count });
    else collect.set(from.block, (collect.get(from.block) ?? 0) + count);
    return null;
  };
  const need = async (item: string, count: number): Promise<string | null> => {
    const how = await howToGet(runtime, item, knowledge);
    if (how === null) return unknownItem(runtime, item);
    const into = how === "craft" ? crafted : how === "smelt" ? smelts : null;
    if (into === null) return gathered(item, count);
    into.set(item, (into.get(item) ?? 0) + count);
    return null;
  };
  for (const entry of missing) {
    const problem = await need(entry.item, entry.count);
    if (problem !== null) return problem;
  }
  // Furnace jobs, crafts and harvest tools each bring needs of their own (sand and fuel, a furnace, the leaves of the
  // crafts, a pickaxe for their stone), which may be furnace jobs again (stone for smooth stone): settle them until
  // nothing new comes up.
  let craftedSeen = "";
  let toolsSeen = "";
  let tools: string[] = [];
  for (let pass = 0; pass < 8; pass += 1) {
    for (const [output, count] of smelts) {
      if (jobs.has(output)) continue;
      const input = chooseInput(knowledge.smelted.get(output)!, inventory);
      const fuel = chooseFuel(count, input, inventory, missing, knowledge.fuels);
      jobs.set(output, { output, count, input, ...fuel });
      for (const [item, wantedCount] of [[input, count], [fuel.fuel, fuel.fuelCount], [FURNACE, 1]] as const) {
        const short = wantedCount - carried(inventory, item);
        if (short <= 0 || (item === FURNACE && crafted.has(FURNACE))) continue;
        const problem = await need(item, short);
        if (problem !== null) return problem;
      }
    }
    tools = await missingTools(runtime, [...collect.keys(), ...leaves.keys()], inventory, knowledge);
    if (pass > 0 && jobs.size >= smelts.size && craftedSeen === signature(crafted) && toolsSeen === tools.join(",")) break;
    craftedSeen = signature(crafted);
    toolsSeen = tools.join(",");
    const batch = [...crafted].map(([item, count]) => ({ item, count }));
    if (batch.length === 0 && tools.length === 0) continue;
    leaves = new Map();
    huntedLeaves = new Map();
    const needs = await runtime.craftingNeeds(withTools(batch, tools, inventory), await nearbyWoods(runtime, knowledge));
    if (needs.status === "uncraftable" || needs.status === "planner_failed" || needs.status === "unknown") {
      return `cannot work out how to craft ${describeMaterials([...batch, ...tools.map((item) => ({ item, count: 1 }))])}`;
    }
    for (const leaf of needs.missing) {
      // A leaf a furnace makes (glass for panes) is a furnace job; the others are gathered.
      if ((await howToGet(runtime, leaf.item, knowledge)) === "smelt") smelts.set(leaf.item, Math.max(smelts.get(leaf.item) ?? 0, leaf.count));
      else {
        const from = await gatherFrom(runtime, leaf.item, knowledge);
        if (from === null) return notDropped(runtime, leaf.item, knowledge);
        if ("mob" in from) huntedLeaves.set(leaf.item, { mob: from.mob, count: (huntedLeaves.get(leaf.item)?.count ?? 0) + leaf.count });
        else leaves.set(from.block, (leaves.get(from.block) ?? 0) + leaf.count);
      }
    }
  }
  for (const [block, count] of leaves) collect.set(block, (collect.get(block) ?? 0) + count);
  for (const [item, { mob, count }] of huntedLeaves) hunt.set(item, { mob, count: (hunt.get(item)?.count ?? 0) + count });
  const toolFirst = await chooseTool(runtime, tools);
  // A placed table she would walk to is used instead of making one (live 2026-10-07: a table was crafted, and lost,
  // beside one already standing).
  const tableFirst = (toolFirst !== null || crafted.size > 0) && carried(inventory, TABLE.item) === 0
    && (await placedStation(runtime, TABLE.item, STATION_RANGE_NONE_CARRIED)) === undefined;
  return {
    collect,
    hunt,
    tableFirst,
    toolFirst,
    craft: [...crafted].map(([item, count]) => ({ item, count })),
    smelt: [...jobs.values()],
  };
}

function signature(counts: ReadonlyMap<string, number>): string {
  return [...counts].map(([item, count]) => `${item}:${count}`).join(",");
}

/** The cheapest tool `block` drops anything with, when it carries none of them; null when it can be collected now. */
function toolMissing(block: string, inventory: Stacks, knowledge: Knowledge): string | null {
  const harvest = knowledge.harvest.get(block) ?? null;
  if (harvest !== null && !harvest.some((tool) => carried(inventory, tool) > 0)) return harvest[0] ?? null;
  // A tool that broke on the way is made again for the blocks of its class, even those a hand digs (live run 13: the
  // wooden shovel, then dirt by hand): the best the materials allow, as a level's tool is chosen.
  const kind = knowledge.toolClass.get(block) ?? null;
  if (kind === null || !knowledge.lost.has(kind) || inventory.some((stack) => stack.name.endsWith(`_${kind}`))) return null;
  return toolToMake(kind, (item) => carried(inventory, item));
}

/** Whether `block` drops nothing without a harvest tool that is not carried (game data: stone without a pickaxe). */
function requiresTool(block: string, inventory: Stacks, knowledge: Knowledge): boolean {
  const harvest = knowledge.harvest.get(block) ?? null;
  return harvest !== null && !harvest.some((tool) => carried(inventory, tool) > 0);
}

/** The harvest tools still to make for `blocks`, learning each block's harvest tools from game data once. */
async function missingTools(runtime: BotRuntime, blocks: readonly string[], inventory: Stacks, knowledge: Knowledge): Promise<string[]> {
  const unknown = [...new Set(blocks)].filter((block) => !knowledge.harvest.has(block));
  if (unknown.length > 0) {
    const kinds = await runtime.blockKinds(unknown);
    // Not a block (an item gathered some other way): nothing to dig it with.
    for (const block of unknown) {
      knowledge.harvest.set(block, kinds[block]?.harvest ?? null);
      knowledge.toolClass.set(block, kinds[block]?.tool ?? null);
    }
  }
  const tools = blocks.map((block) => toolMissing(block, inventory, knowledge)).filter((tool): tool is string => tool !== null);
  return [...new Set(tools)];
}

/**
 * The tool to craft first: one it can craft right now (the wooden pickaxe before the stone one that needs its
 * cobblestone), else the first; null when none is missing.
 */
async function chooseTool(runtime: BotRuntime, tools: readonly string[]): Promise<string | null> {
  for (const tool of tools) if ((await runtime.craftingNeeds([{ item: tool, count: 1 }])).status === "ready") return tool;
  return tools[0] ?? null;
}

/** `batch`, with the crafting table and harvest tools it still has to make first, so their leaves are counted too. */
function withTools(batch: readonly ItemCount[], tools: readonly string[], inventory: Stacks): ItemCount[] {
  const table = carried(inventory, TABLE.item) === 0;
  return [...(table ? [TABLE] : []), ...tools.map((item) => ({ item, count: 1 })), ...batch];
}

/**
 * Says so once a rare drop has cost {@link RARE_DROP_BREAKS} blocks without being gained; null while it is still worth
 * trying. A gain starts the count again.
 */
function rareFruitless(knowledge: Knowledge, inventory: Stacks): string | null {
  for (const [block, fetch] of knowledge.rare) {
    const now = carried(inventory, fetch.item);
    if (now > fetch.had && fetch.had >= 0) fetch.broken = 0;
    fetch.had = now;
    if (fetch.broken >= RARE_DROP_BREAKS) {
      return `broke ${fetch.broken} ${block} without gaining ${fetch.item}: it drops from ${fetch.blocks.join(", ")} but the drop is ${rareNote(fetch.chance)}, so this fetch stops here; decide whether more of it is worth the time, or do something else`;
    }
  }
  return null;
}

async function collectAll(context: GatherContext, targets: readonly (readonly [string, number])[], purpose: string, knowledge: Knowledge): Promise<GatherResult> {
  const done: string[] = [];
  for (const [block, total] of targets) {
    context.progress?.(`gathering ${total} ${block} for ${purpose}`);
    const rare = knowledge.rare.get(block);
    for (let left = total; left > 0; left -= MAX_COLLECT) {
      // A rare drop is asked for only as many blocks as its bound still allows.
      const count = Math.max(1, Math.min(left, MAX_COLLECT, rare === undefined ? MAX_COLLECT : RARE_DROP_BREAKS - rare.broken));
      let broken = 0;
      const countBroken = (outcome: ActOutcome) => { broken += blocksBroken(outcome.result); };
      // A rare drop is also told the breaks it has left, so one call cannot spend the budget of its chance (hundreds of leaves).
      const breaksLeft = (): number | null => rare === undefined ? null : Math.max(1, RARE_DROP_BREAKS - rare.broken - broken);
      let step = await act(context, "collect_block", { block_name: block, count, max_distance: FETCH_RANGE, ...(breaksLeft() !== null && { max_breaks: breaksLeft() }) }, `Gather ${count} ${block} for ${purpose}.`, knowledge.lost, countBroken);
      if (step?.status === "failed" && noneUsableNear(step.detail)) step = await fetchFarther(context, block, count, purpose, step, countBroken, breaksLeft);
      // The blocks broken, as the runtime counts them, not the drops that came (a rare drop comes from few of them).
      if (rare !== undefined) rare.broken += broken;
      if (step !== null) return step.status === "failed" ? { status: "failed", detail: await notNear(context, block, step.detail) } : step;
    }
    done.push(`collected ${total} ${block}`);
  }
  return { status: "done", detail: done.join(", ") };
}

/** Places tried, nearest first, in one gathering. */
const FAR_TRIES = 5;
/** The nearest places looked at, at most, in one gathering. */
const FAR_CANDIDATES = 256;
/**
 * Places that held nothing she may take, by bot (chunk middles, "x,z"), for this run: not tried again. The runtime
 * rescans a chunk loaded again after 10 minutes, so its record catches up with the world anyway.
 */
const triedPlaces = new WeakMap<BotRuntime, Set<string>>();

/** Nothing within range, or nothing there she can take (inside protected areas, under water, blocked). */
function noneUsableNear(detail: string): boolean {
  const code = errorCode(detail);
  return code === "NO_TARGET_IN_RANGE" || code === "NO_LOADED_MATCHING_TARGETS" ||
    (code === "NO_REACHABLE_MATCHING_TARGETS" && !/no carried tool/u.test(detail));
}

/**
 * The places beyond the near search where she saw `block` (the bot data's record of what each explored chunk holds),
 * nearest first, at any distance, never one she found empty already nor one holding a protected area: gathering is
 * mining, and the blocks of a protected area are its walls (owner, 2026-10-07: "skip entirely protected things"; live
 * 2026-10-04: the nearest oak logs Ayla had seen were her own houses'). The near search still takes the free blocks
 * around them.
 */
export async function knownPlaces(runtime: BotRuntime, block: string, from: Position): Promise<readonly SeenBlock[]> {
  const tried = triedSet(runtime);
  const areas = await runtime.protectedRegions().catch(() => []);
  const guarded = (x: number, z: number) => areas.some((area) => area.min.x <= x + 8 && area.max.x >= x - 8 && area.min.z <= z + 8 && area.max.z >= z - 8);
  // Read once (live 2026-10-04: one query per place, through thousands of chunks, held Ayla still for minutes).
  return (await runtime.seenPlaces(block, from, FETCH_RANGE, FAR_CANDIDATES).catch(() => []))
    .filter((place) => !tried.has(`${place.x},${place.z}`) && !guarded(place.x, place.z));
}

function triedSet(runtime: BotRuntime): Set<string> {
  const tried = triedPlaces.get(runtime) ?? new Set<string>();
  triedPlaces.set(runtime, tried);
  return tried;
}

/**
 * A near search that found none has looked at every place within its range: the record's places there are stale
 * (cut since, or never what the record says) and are not offered again this run (live 2026-10-07: spruce "seen" 6
 * blocks from Ayla, none loaded; `explore` kept sending her back to it, `get_items` found none, for 15 minutes).
 */
async function forgetEmptyNear(runtime: BotRuntime, block: string, here: Position): Promise<void> {
  const tried = triedSet(runtime);
  for (const place of await runtime.seenPlaces(block, here, 0, FAR_CANDIDATES).catch(() => [])) {
    if (Math.hypot(place.x - here.x, place.z - here.z) > FETCH_RANGE) break;
    tried.add(`${place.x},${place.z}`);
  }
}

/**
 * None of `block` near that she may take: the nearest places she knows of ({@link knownPlaces}), at any distance, walked
 * to and collected there (owner, 2026-10-07: "return the closest known resource and that's it"; a way over deep water
 * needs a boat, and `navigate` says so). Null when collected, else what went wrong; with no place known, she is told to
 * explore.
 */
async function fetchFarther(context: GatherContext, block: string, count: number, purpose: string, failed: GatherResult, observe?: (outcome: ActOutcome) => void, breaksLeft: () => number | null = () => null): Promise<GatherResult | null> {
  const tried = triedSet(context.runtime);
  const start = (await context.runtime.status()).position;
  const code = failed.status === "failed" ? errorCode(failed.detail) : null;
  // Trees near that none could be reached are as good as none (live 2026-10-10: the same unreachable trees, round after round).
  if (code === "NO_TARGET_IN_RANGE" || code === "NO_LOADED_MATCHING_TARGETS" || code === "NO_REACHABLE_MATCHING_TARGETS") await forgetEmptyNear(context.runtime, block, start);
  const places = await knownPlaces(context.runtime, block, start);
  if (places.length === 0) {
    const why = failed.status === "failed" ? ` (${failed.detail})` : "";
    return { status: "failed", detail: `no ${block} within ${FETCH_RANGE} blocks that you may take, and you know of none farther away outside protected areas: explore for it (toward land you have not seen), use another material, or say so${why}` };
  }
  let last = failed;
  let acrossWater = 0;
  const boat = (await context.runtime.status()).inventory.some((stack) => stack.name.endsWith("_boat") || stack.name.endsWith("_raft"));
  let tries = 0;
  for (const seen of places) {
    if (context.signal.aborted || tries >= FAR_TRIES) break;
    const here = (await context.runtime.status()).position;
    // Across deep water with no boat the walk fails: not tried, and not marked either (a boat may come).
    if (!boat) {
      const water = await context.runtime.waterAlong(here, { x: seen.x, y: here.y, z: seen.z }).catch(() => null);
      if (water !== null && water.share > 0.5) {
        acrossWater += 1;
        continue;
      }
    }
    tries += 1;
    context.progress?.(`going ${describeWay(here, seen)} to the ${block} seen there, for ${purpose}`);
    const why = `Go to the ${block} I saw ${describeWay(here, seen)}, for ${purpose}.`;
    // Caves under the ground, trees over it: the walk is to the ground nearest her own height (as `explore` does).
    context.heading?.({ x: seen.x, z: seen.z });
    const there = await act(context, "navigate", { x: seen.x, z: seen.z, near_y: Math.floor(here.y), range: 12 }, why);
    context.heading?.(null);
    if (there !== null) {
      // A place that could not be reached is not offered again by the next round.
      tried.add(`${seen.x},${seen.z}`);
      last = there;
      // The same water lies between her and the next far place: not walked to (live 2026-10-10 run 10: ~1500 blocks swum).
      if (there.status === "failed" && errorCode(there.detail) === "NAVIGATION_DEEP_WATER") return { status: "failed", detail: await acrossWaterHint(context.runtime, block, failed) };
      continue;
    }
    const step = await act(context, "collect_block", { block_name: block, count, max_distance: FETCH_RANGE, ...(breaksLeft() !== null && { max_breaks: breaksLeft() }) }, `Gather ${count} ${block} for ${purpose}.`, undefined, observe);
    if (step === null) return null;
    last = step;
    if (step.status !== "failed" || !noneUsableNear(step.detail)) return step;
    tried.add(`${seen.x},${seen.z}`);
  }
  if (tries === 0 && acrossWater > 0) return { status: "failed", detail: await acrossWaterHint(context.runtime, block, failed) };
  return last;
}

/** What a fetch tells when the places it knows lie across deep water and no boat is carried. */
async function acrossWaterHint(runtime: BotRuntime, block: string, failed: GatherResult): Promise<string> {
  return `the ${block} you know of is across the water: take a boat (get_items ${await boatToMake(runtime)}) and go_to there, use another material, or say so (${failed.status === "failed" ? failed.detail : "none near"})`;
}

/** The boat a fetch names when nothing carried says otherwise. */
const DEFAULT_BOAT = "oak_boat";

/** The game's block tags of a wood: the logs (stems and wood blocks included) and the planks of every tree. */
const WOOD_TAGS = ["logs", "planks"];

/** Per bot, whether each carried name is a wood in the game's data (its block tags, asked once per name). */
const woodNames = new WeakMap<BotRuntime, Map<string, boolean>>();

/** Whether `name` is a wood (a log, a stem, a plank), by the game's block tags; an item that is no block is not. */
async function isWood(runtime: BotRuntime, name: string): Promise<boolean> {
  const known = woodNames.get(runtime) ?? new Map<string, boolean>();
  woodNames.set(runtime, known);
  let wood = known.get(name);
  if (wood === undefined) {
    const tags = (await runtime.blockKinds([name]))[name]?.tags ?? [];
    wood = WOOD_TAGS.some((tag) => tags.includes(tag));
    known.set(name, wood);
  }
  return wood;
}

/**
 * The boat she can make from the wood she carries: each carried wood (a log, stem or planks by the game's block tags;
 * an iron block is none) gives the boats whose recipe takes its planks (the game's recipe data, `boats.ts`), and the game's
 * craft planner says whether what she carries fits one. A wood with no boat recipe (a crimson stem) costs no planner call.
 * A boat she can craft now comes first,
 * then one with a recipe, then {@link DEFAULT_BOAT} (live 2026-10-15 run 12: Ayla, on an island with birch, was told
 * oak_boat over and over).
 */
async function boatToMake(runtime: BotRuntime): Promise<string> {
  const boats = new Set<string>();
  for (const stack of (await runtime.status()).inventory) {
    if (await isWood(runtime, stack.name)) for (const boat of await boatsOfWood(runtime, stack.name)) boats.add(boat);
  }
  let possible: string | null = null;
  for (const boat of boats) {
    const status = (await runtime.craftingNeeds([{ item: boat, count: 1 }])).status;
    if (status === "ready") return boat;
    if (status === "missing_materials") possible ??= boat;
  }
  return possible ?? DEFAULT_BOAT;
}

/** The eight compass directions, by the angle from east going south (Minecraft's +z is south). */
const COMPASS = ["east", "south-east", "south", "south-west", "west", "north-west", "north", "north-east"] as const;

/**
 * A collect that found nothing in range, told with what the bot knows: where it saw that block before beyond that range
 * (the bot data's explored chunks), how far and which way, or that it knows of none; the model decides what to do (go there, use another
 * material, tell whoever asked). Other failures are passed on as they are.
 */
export async function notNear(context: Pick<GatherContext, "runtime">, block: string, detail: string): Promise<string> {
  const code = errorCode(detail);
  if (code !== "NO_TARGET_IN_RANGE" && code !== "NO_LOADED_MATCHING_TARGETS") return detail;
  const here = (await context.runtime.status()).position;
  await forgetEmptyNear(context.runtime, block, here);
  // A place she may still take from in this world, else one seen in another dimension.
  const elsewhere = await context.runtime.seenAt(block, here, FETCH_RANGE).catch(() => null);
  const seen = (await knownPlaces(context.runtime, block, here))[0] ?? (elsewhere?.dimension === "overworld" ? null : elsewhere);
  const near = `no ${block} within ${FETCH_RANGE} blocks`;
  if (seen === null) return `${near}, and you know of none farther away: explore for it (toward land you have not seen), use another material, or say so (${detail})`;
  if (seen.dimension !== "overworld") return `${near}; you saw some in ${seen.dimension.replaceAll("_", " ")} around ${seen.x} ${seen.z} (${detail})`;
  // Across water she knows (the explored chunks on the straight way are mostly water): a trip by boat (spec 2026-10-04).
  const water = await context.runtime.waterAlong(here, { x: seen.x, y: here.y, z: seen.z }).catch(() => null);
  if (water !== null && water.share > 0.5) {
    const boat = (await context.runtime.status()).inventory.some((stack) => stack.name.endsWith("_boat") || stack.name.endsWith("_raft"));
    const trip = boat ? "go_to there crosses by boat (you carry one)" : `take a boat (get_items ${await boatToMake(context.runtime)}) and go_to there`;
    return `${near}; you saw some ${describeWay(here, seen)}, across the water, around ${seen.x} ${Math.floor(here.y)} ${seen.z}: ${trip} if it is worth the trip, use another material, or say so (${detail})`;
  }
  return `${near}; you saw some ${describeWay(here, seen)}, around ${seen.x} ${Math.floor(here.y)} ${seen.z}: go_to there yourself if it is worth the trip, use another material, or say so (${detail})`;
}

/** "18 blocks south-west": how far `to` is from `from` across the ground, and which way. */
export function describeWay(from: { readonly x: number; readonly z: number }, to: { readonly x: number; readonly z: number }): string {
  const [dx, dz] = [to.x - from.x, to.z - from.z];
  return `${Math.round(Math.hypot(dx, dz))} blocks ${COMPASS[(Math.round(Math.atan2(dz, dx) / (Math.PI / 4)) + 8) % 8]}`;
}

/** Walks back near `home` when farther than {@link HOME_RANGE}; null when there (or back). */
async function goHome(context: GatherContext, home: Position, purpose: string, work: string): Promise<GatherResult | null> {
  const here = (await context.runtime.status()).position;
  if (Math.hypot(here.x - home.x, here.y - home.y, here.z - home.z) <= HOME_RANGE) return null;
  const target = { x: Math.floor(home.x), y: Math.floor(home.y), z: Math.floor(home.z), range: 1 };
  return act(context, "navigate", target, `Go back to the site to ${work} for ${purpose}.`);
}

/** Where crafting and smelting happen: `home` at first, the dry ground she moved to when no workstation fit there. */
interface Site {
  home: Position;
}

/** Crafts with the carried table set down near the site's home, walking back there first when needed. */
async function craftAtHome(context: GatherContext, items: readonly ItemCount[], purpose: string, site: Site, spent: Spent): Promise<GatherResult> {
  // A table close by is used where it stands, as a player would (owner, 2026-10-02: "check first if one is close").
  if ((await walkToStation(context, "crafting_table")) !== null) return craft(context, items, purpose, false, spent);
  const back = await goHome(context, site.home, purpose, "craft");
  if (back !== null) return back;
  // Back at the site, a table close to it counts too (live 2026-10-02: one 6 blocks from the site went unused
  // because she looked from where the logs were).
  if ((await walkToStation(context, "crafting_table")) !== null) return craft(context, items, purpose, false, spent);
  return withRoomForStation(context, site, () => craft(context, items, purpose, true, spent));
}

/**
 * A carried workstation needs a dry, clear cell with something solid under it within reach; in water, or in a crowded
 * tunnel, none is free (live 2026-10-02, and 2026-10-07 at the water's edge: "crafting_table: no_cell", and the boat
 * she needed was never crafted). A player steps onto dry ground first: she walks to the nearest land she has seen and
 * sets it down there, once; that ground is home for the rest of the gathering.
 */
async function withRoomForStation(context: GatherContext, site: Site, run: () => Promise<GatherResult>): Promise<GatherResult> {
  const first = await run();
  if (first.status !== "failed" || !/\[WORKSTATION_PLACEMENT_FAILED\] \S+: no_cell/u.test(first.detail)) return first;
  const here = (await context.runtime.status()).position;
  const land = await context.runtime.nearestLand(here).catch(() => null);
  if (land === null) return first;
  const why = "Step onto dry, open ground to set the workstation down.";
  const moved = await act(context, "navigate", { x: land.x, z: land.z, near_y: Math.floor(here.y), range: 4 }, why);
  if (moved !== null) return first;
  site.home = (await context.runtime.status()).position;
  return run();
}

/**
 * Smelts (at most one furnace load) in a furnace close by, else in the carried furnace set down near `home`, walking
 * back there first when needed.
 */
async function smeltAtHome(context: GatherContext, job: SmeltJob, purpose: string, site: Site): Promise<GatherResult> {
  const count = Math.min(job.count, MAX_SMELT);
  const load = { item_name: job.input, count, fuel_item_name: job.fuel };
  const rationale = `Smelt ${count} ${job.input} into ${job.output} for ${purpose}.`;
  const done: GatherResult = { status: "done", detail: `smelted ${count} ${job.output} from ${job.input} with ${job.fuel}` };
  context.progress?.(`smelting ${count} ${job.input} into ${job.output} for ${purpose}`);
  const furnace = await walkToStation(context, "furnace");
  // A furnace still holding someone's items refuses the load: then her own, as if there were none.
  if (furnace !== null && (await act(context, "smelt_item", { ...load, ...furnace }, rationale)) === null) return done;
  if (context.signal.aborted) return { status: "stopped" };
  const back = await goHome(context, site.home, purpose, "smelt");
  if (back !== null) return back;
  const atHome = furnace === null ? await walkToStation(context, "furnace") : null;
  if (atHome !== null && (await act(context, "smelt_item", { ...load, ...atHome }, rationale)) === null) return done;
  if (context.signal.aborted) return { status: "stopped" };
  return withRoomForStation(context, site, async () => (await act(context, "smelt_item", { ...load, temporary_workstation: true }, rationale)) ?? done);
}

/** Within this many blocks, a placed crafting table or furnace is walked to and used instead of setting one down. */
const STATION_RANGE = 16;
/**
 * Without one of her own, a placed one is walked to from farther: making one costs materials, not just a few steps
 * (owner, 2026-10-07).
 */
const STATION_RANGE_NONE_CARRIED = 48;

/**
 * Walks up to the nearest placed `block` when one is within {@link STATION_RANGE} (or
 * {@link STATION_RANGE_NONE_CARRIED} when she carries none); where it stands, or null when none is that close or the
 * way there fails (then a carried one is set down as before).
 */
export async function walkToStation(context: GatherContext, block: "crafting_table" | "furnace"): Promise<Position | null> {
  const { inventory } = await context.runtime.status();
  const range = inventory.some((stack) => stack.name === block) ? STATION_RANGE : STATION_RANGE_NONE_CARRIED;
  const found = await placedStation(context.runtime, block, range);
  if (found === undefined) return null;
  // Coordinates only: the result is spread into `navigate` and `smelt_item` inputs, which refuse unknown keys (live
  // 2026-10-03: the block's `name` made every walk to a crafting table fail validation).
  const station = { x: found.x, y: found.y, z: found.z };
  const outcome = await context.body.act("navigate", { ...station, range: 2 }, `Walk to the ${block.replaceAll("_", " ")} close by to use it.`, { signal: context.signal });
  return outcome.status === "succeeded" ? station : null;
}

/** Told the inventory just before and just after one craft or smelt. */
type Spent = (before: Stacks, after: Stacks) => void;

/** The nearest placed `block` within `range` blocks of her; undefined when none is that close. */
async function placedStation(runtime: BotRuntime, block: string, range: number): Promise<FoundBlock | undefined> {
  const here = (await runtime.status()).position;
  const found = (await runtime.findBlocks(block, 1))[0];
  return found !== undefined && Math.hypot(found.x - here.x, found.y - here.y, found.z - here.z) <= range ? found : undefined;
}

/** `withTable`: set the carried crafting table down for this batch and pick it up again. */
async function craft(context: GatherContext, items: readonly ItemCount[], purpose: string, withTable: boolean, spent: Spent): Promise<GatherResult> {
  const input = { items: items.map(({ item, count }) => ({ item_name: item, count })), ...(withTable && { temporary_workstation: true }) };
  const before = (await context.runtime.status()).inventory;
  context.progress?.(`crafting ${describeMaterials(items)} for ${purpose}`);
  const step = await act(context, "craft_item", input, `Craft ${describeMaterials(items)} for ${purpose}.`);
  if (step?.status !== "stopped") spent(before, (await context.runtime.status()).inventory);
  return step ?? { status: "done", detail: `crafted ${describeMaterials(items)}` };
}

/** Hunts each item from its mob (`collect_mob_drop`: it finds, fights and picks up), one after the other. */
async function huntAll(context: GatherContext, hunts: ReadonlyMap<string, { readonly mob: string; readonly count: number }>, purpose: string, knowledge: Knowledge): Promise<GatherResult> {
  const done: string[] = [];
  // No hostile mob spawns on a peaceful server (run 12: rotten_flesh and bone hunts ended in HUNT_TARGET_NOT_LOADED): refuse before walking.
  const hostile = [...hunts].find(([item]) => knowledge.mob.get(item)?.hostile === true);
  if (hostile !== undefined && (await context.runtime.status()).difficulty === "peaceful") {
    return { status: "failed", detail: `no ${hostile[1].mob} spawns on this peaceful server: ${hostile[0]} cannot be hunted here` };
  }
  for (const [item, { mob, count }] of hunts) {
    context.progress?.(`hunting ${mob} for ${count} ${item}, for ${purpose}`);
    const step = await act(context, "collect_mob_drop", { mob_name: mob, drop_name: item, count }, `Hunt ${mob} for ${count} ${item}, for ${purpose}.`);
    if (step !== null) return step;
    done.push(`got ${count} ${item} from ${mob}`);
  }
  return { status: "done", detail: done.join(", ") };
}

/** The part of a `collect_block` result that names a tool which broke during the run (src/actions/collect-block/contract.ts). */
const toolLostSchema = z.object({ collected: z.object({ toolLost: z.object({ class: z.string() }) }) });

/**
 * Runs one action; null when it succeeded. A tool the runtime says broke during it (`toolLost`, succeeded or not) is
 * added to `lost`; `observe` sees each outcome.
 */
async function act(context: GatherContext, tool: "collect_block" | "collect_mob_drop" | "craft_item" | "smelt_item" | "navigate" | "use_bucket", input: Record<string, unknown>, rationale: string, lost?: Set<string>, observe?: (outcome: ActOutcome) => void): Promise<GatherResult | null> {
  let outcome = await context.body.act(tool, input, rationale, { signal: context.signal });
  const broke = toolLostSchema.safeParse(outcome.result);
  if (broke.success) lost?.add(broke.data.collected.toolLost.class);
  if (context.signal.aborted) return { status: "stopped" };
  // A craft or a smelt with no room for its result or its workstation: room is made once, then it runs again (run 12).
  if (outcome.status !== "succeeded" && (tool === "craft_item" || tool === "smelt_item") && FULL_INVENTORY.test(outcome.error ?? "") && context.makeRoom !== undefined && (await context.makeRoom(await consumedBy(context.runtime, tool, input)))) {
    outcome = await context.body.act(tool, input, rationale, { signal: context.signal });
    if (context.signal.aborted) return { status: "stopped" };
  }
  observe?.(outcome);
  if (outcome.status === "succeeded") return null;
  return { status: "failed", detail: outcome.error ?? `${tool} ${outcome.status}` };
}

/** What a `collect_block` result reports (src/actions/collect-block/contract.ts `collected`), on success and on failure. */
const collectedSchema = z.object({ collected: z.object({ blocksBroken: z.number() }) });

/** The matching blocks a `collect_block` result reports broken; 0 when it reports none. */
function blocksBroken(result: ActOutcome["result"]): number {
  return collectedSchema.safeParse(result).data?.collected.blocksBroken ?? 0;
}
