// Plans one round of a gathering: what to collect, hunt, craft and smelt, and which tools to make first.
import { describeMaterials } from "../building/blueprint.ts";
import { toolToMake } from "../building/tool-loss.ts";
import { carriesFamily } from "../inventory-room.ts";
import { stackSizeOf } from "../newest-registry.ts";
import type { BotRuntime, ItemCount, SmeltingRecipe } from "../runtime-client.ts";
import { gatherFrom, howToGet, isOre, nearbyWoods, notDropped, unknownItem, type Knowledge } from "./how-to-get.ts";
import { carried, type Stacks } from "./stacks.ts";
import { placedStation, STATION_RANGE_NONE_CARRIED } from "./stations.ts";

/** The runtime's `smelt_item` limit per call: one furnace input slot. */
export const MAX_SMELT = 64;
/** Fuel made when none is carried: planks of the wood it carries, else these. */
const DEFAULT_FUEL = "oak_planks";

/** One furnace job: `count` of `output` from `input`, burning `fuel`. */
export interface SmeltJob {
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
export interface Round {
  readonly collect: ReadonlyMap<string, number>;
  /** What to hunt: item → the mob that drops it and how many. */
  readonly hunt: ReadonlyMap<string, { readonly mob: string; readonly count: number }>;
  readonly tableFirst: boolean;
  /** The harvest tool to craft before some block to collect drops anything (a wooden pickaxe for stone). */
  readonly toolFirst: string | null;
  /** The tool class (`pickaxe`...) of {@link toolFirst} as the game data names it for the block it opens (a lost class is `knowledge.lost`'s); null when none. */
  readonly toolFirstKind: string | null;
  readonly craft: readonly ItemCount[];
  readonly smelt: readonly SmeltJob[];
}

export const TABLE = { item: "crafting_table", count: 1 } as const;
const FURNACE = "furnace";

/** The input a furnace job uses: the one it carries most of, else the game's first that is not an ore block. */
function chooseInput(recipes: readonly SmeltingRecipe[], inventory: Stacks): string {
  const inputs = recipes.flatMap((recipe) => recipe.inputs).filter((input) => !isOre(input));
  const best = [...inputs].sort((a, b) => carried(inventory, b) - carried(inventory, a))[0]!;
  return carried(inventory, best) > 0 ? best : inputs[0]!;
}

/**
 * The fuel for smelting `count` items, never the input itself nor an item one slot holds alone (a full bucket, a boat:
 * kept for their use): a fuel carried or being fetched anyway (`coming`) that covers the job (the one burning the fewest
 * items: coal before planks), else planks of the wood it carries, else oak planks; with how many it burns.
 */
function chooseFuel(count: number, input: string, inventory: Stacks, coming: readonly ItemCount[], fuels: Readonly<Record<string, number>>): { fuel: string; fuelCount: number; fuelWorth: number } {
  const worth = (name: string) => (name === input || stackSizeOf(name) === 1 ? 0 : fuels[name] ?? 0);
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
export function smeltReady(job: SmeltJob, inventory: Stacks): boolean {
  const load = Math.min(job.count, MAX_SMELT);
  return carried(inventory, FURNACE) > 0 && carried(inventory, job.input) >= load && carried(inventory, job.fuel) >= Math.ceil(load / job.fuelWorth);
}

/**
 * The crafts of `items` it can do right now (every material carried), in one batch: all of them, else those that can
 * each be done (the furnace and the fuel planks, not yet the panes waiting for glass) when they fit together, else the
 * first of those.
 */
export async function readyCrafts(runtime: BotRuntime, items: readonly ItemCount[]): Promise<readonly ItemCount[]> {
  if (items.length === 0) return [];
  if ((await runtime.craftingNeeds(items)).status === "ready") return items;
  const ready: ItemCount[] = [];
  for (const item of items) if ((await runtime.craftingNeeds([item])).status === "ready") ready.push(item);
  if (ready.length > 1 && (await runtime.craftingNeeds(ready)).status !== "ready") return ready.slice(0, 1);
  return ready;
}

/** What the next rounds need, or why it cannot be done. */
export async function planRound(runtime: BotRuntime, missing: readonly ItemCount[], inventory: Stacks, knowledge: Knowledge): Promise<Round | string> {
  const tally = new RoundTally(runtime, knowledge);
  for (const entry of missing) {
    const problem = await tally.need(entry.item, entry.count);
    if (problem !== null) return problem;
  }
  // Furnace jobs, crafts and harvest tools each bring needs of their own (sand and fuel, a furnace, the leaves of the
  // crafts, a pickaxe for their stone), which may be furnace jobs again (stone for smooth stone): settle them until
  // nothing new comes up.
  let craftedSeen = "";
  let toolsSeen = "";
  let missingToolList: MissingTool[] = [];
  let tools: string[] = [];
  for (let pass = 0; pass < 8; pass += 1) {
    const jobProblem = await addSmeltJobs(tally, inventory, missing);
    if (jobProblem !== null) return jobProblem;
    missingToolList = await missingTools(runtime, [...tally.collect.keys(), ...tally.leaves.keys()], inventory, knowledge);
    tools = missingToolList.map(({ item }) => item);
    if (pass > 0 && tally.jobs.size >= tally.smelts.size && craftedSeen === signature(tally.crafted) && toolsSeen === tools.join(",")) break;
    craftedSeen = signature(tally.crafted);
    toolsSeen = tools.join(",");
    const leafProblem = await addCraftLeaves(tally, inventory, tools);
    if (leafProblem !== null) return leafProblem;
  }
  for (const [block, count] of tally.leaves) tally.collect.set(block, (tally.collect.get(block) ?? 0) + count);
  for (const [item, { mob, count }] of tally.huntedLeaves) tally.hunt.set(item, { mob, count: (tally.hunt.get(item)?.count ?? 0) + count });
  const toolFirst = await chooseTool(runtime, tools);
  const toolFirstKind = missingToolList.find(({ item }) => item === toolFirst)?.kind ?? null;
  // A placed table she would walk to is used instead of making one (live 2026-10-07: a table was crafted, and lost,
  // beside one already standing).
  const tableFirst = (toolFirst !== null || tally.crafted.size > 0) && carried(inventory, TABLE.item) === 0
    && (await placedStation(runtime, TABLE.item, STATION_RANGE_NONE_CARRIED)) === undefined;
  return {
    collect: tally.collect,
    hunt: tally.hunt,
    tableFirst,
    toolFirst,
    toolFirstKind,
    craft: [...tally.crafted].map(([item, count]) => ({ item, count })),
    smelt: [...tally.jobs.values()],
  };
}

/** What one planning of a round has counted so far: blocks to collect, mobs to hunt, crafts, furnace jobs. */
class RoundTally {
  readonly collect = new Map<string, number>();
  readonly hunt = new Map<string, { mob: string; count: number }>();
  /** The gathered leaves of the crafts, worked out again on each pass as the crafts grow. */
  leaves = new Map<string, number>();
  huntedLeaves = new Map<string, { mob: string; count: number }>();
  readonly crafted = new Map<string, number>();
  readonly smelts = new Map<string, number>();
  readonly jobs = new Map<string, SmeltJob>();
  readonly runtime: BotRuntime;
  readonly knowledge: Knowledge;

  constructor(runtime: BotRuntime, knowledge: Knowledge) {
    this.runtime = runtime;
    this.knowledge = knowledge;
  }

  /** Counts `count` of `item` as crafted, smelted or gathered; the reason it cannot be had, or null. */
  async need(item: string, count: number): Promise<string | null> {
    const how = await howToGet(this.runtime, item, this.knowledge);
    if (how === null) return unknownItem(this.runtime, item);
    const into = how === "craft" ? this.crafted : how === "smelt" ? this.smelts : null;
    if (into === null) return this.gathered(item, count);
    into.set(item, (into.get(item) ?? 0) + count);
    return null;
  }

  /** Counts `count` of `item` as collected from its block or hunted from its mob; the reason when neither drops it, or null. */
  async gathered(item: string, count: number): Promise<string | null> {
    const from = await gatherFrom(this.runtime, item, this.knowledge);
    if (from === null) return notDropped(this.runtime, item, this.knowledge);
    if ("mob" in from) this.hunt.set(item, { mob: from.mob, count: (this.hunt.get(item)?.count ?? 0) + count });
    else this.collect.set(from.block, (this.collect.get(from.block) ?? 0) + count);
    return null;
  }
}

/** Plans a furnace job for each smelted item not yet planned, and counts what its input, fuel and furnace still need; the reason one cannot be had, or null. */
async function addSmeltJobs(tally: RoundTally, inventory: Stacks, missing: readonly ItemCount[]): Promise<string | null> {
  const { knowledge, smelts, jobs, crafted } = tally;
  for (const [output, count] of smelts) {
    if (jobs.has(output)) continue;
    const input = chooseInput(knowledge.smelted.get(output)!, inventory);
    const fuel = chooseFuel(count, input, inventory, missing, knowledge.fuels);
    jobs.set(output, { output, count, input, ...fuel });
    for (const [item, wantedCount] of [[input, count], [fuel.fuel, fuel.fuelCount], [FURNACE, 1]] as const) {
      const short = wantedCount - carried(inventory, item);
      if (short <= 0 || (item === FURNACE && crafted.has(FURNACE))) continue;
      const problem = await tally.need(item, short);
      if (problem !== null) return problem;
    }
  }
  return null;
}

/**
 * Works out the leaves of the crafts and of the harvest `tools` still to make again, as the crafts have grown: furnace
 * jobs for what a furnace makes, collects and hunts for the rest. Null when done (or when there is nothing to craft),
 * else why the crafts cannot be worked out.
 */
async function addCraftLeaves(tally: RoundTally, inventory: Stacks, tools: readonly string[]): Promise<string | null> {
  const { runtime, knowledge } = tally;
  const batch = [...tally.crafted].map(([item, count]) => ({ item, count }));
  if (batch.length === 0 && tools.length === 0) return null;
  tally.leaves = new Map();
  tally.huntedLeaves = new Map();
  const needs = await runtime.craftingNeeds(withTools(batch, tools, inventory), await nearbyWoods(runtime, knowledge));
  if (needs.status === "uncraftable" || needs.status === "planner_failed" || needs.status === "unknown") {
    return `cannot work out how to craft ${describeMaterials([...batch, ...tools.map((item) => ({ item, count: 1 }))])}`;
  }
  for (const leaf of needs.missing) {
    // A leaf a furnace makes (glass for panes) is a furnace job; the others are gathered.
    if ((await howToGet(runtime, leaf.item, knowledge)) === "smelt") tally.smelts.set(leaf.item, Math.max(tally.smelts.get(leaf.item) ?? 0, leaf.count));
    else {
      const from = await gatherFrom(runtime, leaf.item, knowledge);
      if (from === null) return notDropped(runtime, leaf.item, knowledge);
      if ("mob" in from) tally.huntedLeaves.set(leaf.item, { mob: from.mob, count: (tally.huntedLeaves.get(leaf.item)?.count ?? 0) + leaf.count });
      else tally.leaves.set(from.block, (tally.leaves.get(from.block) ?? 0) + leaf.count);
    }
  }
  return null;
}

function signature(counts: ReadonlyMap<string, number>): string {
  return [...counts].map(([item, count]) => `${item}:${count}`).join(",");
}

/** The cheapest tool `block` drops anything with, when it carries none of them; null when it can be collected now. */
export function toolMissing(block: string, inventory: Stacks, knowledge: Knowledge): string | null {
  const harvest = knowledge.harvest.get(block) ?? null;
  if (harvest !== null && !harvest.some((tool) => carried(inventory, tool) > 0)) return harvest[0] ?? null;
  // A tool that broke on the way is made again for the blocks of its class, even those a hand digs (live run 13: the
  // wooden shovel, then dirt by hand): the best the materials allow, as a level's tool is chosen.
  const kind = knowledge.toolClass.get(block) ?? null;
  if (kind === null || !knowledge.lost.has(kind) || carriesFamily(inventory, kind)) return null;
  return toolToMake(kind, (item) => carried(inventory, item));
}

/** Whether `block` drops nothing without a harvest tool that is not carried (game data: stone without a pickaxe). */
export function requiresTool(block: string, inventory: Stacks, knowledge: Knowledge): boolean {
  const harvest = knowledge.harvest.get(block) ?? null;
  return harvest !== null && !harvest.some((tool) => carried(inventory, tool) > 0);
}

/** A harvest tool still to make, and the tool class (game data) of the block that needs it. */
interface MissingTool {
  readonly item: string;
  readonly kind: string | null;
}

/** The harvest tools still to make for `blocks`, learning each block's harvest tools from game data once. */
async function missingTools(runtime: BotRuntime, blocks: readonly string[], inventory: Stacks, knowledge: Knowledge): Promise<MissingTool[]> {
  const unknown = [...new Set(blocks)].filter((block) => !knowledge.harvest.has(block));
  if (unknown.length > 0) {
    const kinds = await runtime.blockKinds(unknown);
    // Not a block (an item gathered some other way): nothing to dig it with.
    for (const block of unknown) {
      knowledge.harvest.set(block, kinds[block]?.harvest ?? null);
      knowledge.toolClass.set(block, kinds[block]?.tool ?? null);
    }
  }
  const tools = blocks.flatMap((block) => {
    const item = toolMissing(block, inventory, knowledge);
    return item === null ? [] : [{ item, kind: knowledge.toolClass.get(block) ?? null }];
  });
  return tools.filter((tool, index) => tools.findIndex(({ item }) => item === tool.item) === index);
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
