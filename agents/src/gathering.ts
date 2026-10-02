import { describeMaterials, shortfall } from "./building/blueprint.ts";
import type { Body } from "./body.ts";
import { errorCode, type BotRuntime, type ItemCount, type Position, type SmeltingRecipe } from "./runtime-client.ts";

/** The runtime's `collect_block` limit per call (src/actions/collect-block/contract.ts `MAX_COLLECT_BLOCKS`). */
const MAX_COLLECT = 32;
/** The runtime's `smelt_item` limit per call: one furnace input slot. */
const MAX_SMELT = 64;
/** Gather/craft/smelt rounds before giving up; a house takes about five (logs, table, pickaxe, stone, crafting),
 * replacing what crafting used up of the kept items (fences eat planks, planks eat logs) a few more, and glass panes
 * about ten (sand, logs, table, pickaxe, stone, furnace and fuel, glass, panes). */
const MAX_ROUNDS = 24;
/** Farther than this from home, the bot walks back before setting its crafting table or furnace down. */
const HOME_RANGE = 3;
/** Fuel made when none is carried: planks of the wood it carries, else these. */
const DEFAULT_FUEL = "oak_planks";

/** Items that are the drop of a different block: collect_block names the block to break. */
const MINED_FROM: Readonly<Record<string, string>> = { cobblestone: "stone", cobbled_deepslate: "deepslate" };

/** Blocks that drop nothing unless broken with a pickaxe. */
const PICKAXE_BLOCK = /^(stone|deepslate|cobblestone|cobbled_deepslate|andesite|diorite|granite|sandstone|.+_ore)$/u;

export interface GatherContext {
  readonly runtime: BotRuntime;
  readonly body: Body;
  readonly signal: AbortSignal;
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
  readonly tableFirst: boolean;
  readonly pickaxeFirst: boolean;
  readonly craft: readonly ItemCount[];
  readonly smelt: readonly SmeltJob[];
}

const TABLE = { item: "crafting_table", count: 1 } as const;
const PICKAXE = { item: "wooden_pickaxe", count: 1 } as const;
const FURNACE = "furnace";

/** How an item is obtained, learnt once per gathering from the runtime's game data. */
interface Knowledge {
  readonly craftable: Map<string, boolean>;
  readonly smelted: Map<string, readonly SmeltingRecipe[]>;
  /** Items one of each fuel smelts (filled by the first furnace lookup). */
  fuels: Readonly<Record<string, number>>;
}

/**
 * Gets every item of `bill` into the inventory the way a player would: chop and dig the raw materials, craft a
 * crafting table to carry and a wooden pickaxe when stone is needed, smelt in a carried furnace what only a furnace
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
 */
export async function gatherMaterials(
  context: GatherContext,
  bill: readonly ItemCount[],
  purpose: string,
  home: Position,
  keep: readonly ItemCount[] = [],
): Promise<GatherResult> {
  const knowledge: Knowledge = { craftable: new Map(), smelted: new Map(), fuels: {} };
  const actions: string[] = [];
  let wanted = [...bill];
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const inventory = (await context.runtime.status()).inventory;
    const missing = shortfall(wanted, inventory);
    if (missing.length === 0) return { status: "done", detail: actions.length === 0 ? "had everything" : actions.join(", ") };
    const plan = await planRound(context.runtime, missing, inventory, knowledge);
    if (typeof plan === "string") return { status: "failed", detail: plan };

    const ungated = [...plan.collect].filter(([block]) => !PICKAXE_BLOCK.test(block));
    const gated = [...plan.collect].filter(([block]) => PICKAXE_BLOCK.test(block));
    // Only the craft itself counts as using kept items up: dirt spent as scaffold on the walk back home
    // is not fetched again (observed live 2026-10-01: a detour to collect 11 dirt).
    const spent: Spent = (before, after) => {
      wanted = keepWhatCraftingUsed(wanted, keep, before, after);
    };
    let step: GatherResult;
    if (ungated.length > 0) step = await collectAll(context, ungated, purpose);
    else if (plan.tableFirst) step = await craft(context, [TABLE], purpose, false, spent);
    else if (plan.pickaxeFirst) step = await craftAtHome(context, [PICKAXE], purpose, home, spent);
    else if (gated.length > 0) step = await collectAll(context, gated, purpose);
    else {
      const ready = await readyCrafts(context.runtime, plan.craft);
      const job = plan.smelt.find((candidate) => smeltReady(candidate, inventory));
      if (ready.length > 0) step = await craftAtHome(context, ready, purpose, home, spent);
      else if (job !== undefined) step = await smeltAtHome(context, job, purpose, home);
      else return { status: "failed", detail: `cannot work out how to get ${describeMaterials(missing)}: nothing left to gather, craft or smelt` };
    }
    if (step.status === "stopped") return step;
    if (step.status === "failed") {
      // A setback that still got something (a pickaxe that broke after 15 of 16 stones) or a fight that interrupted
      // the work is survival as usual: the next round sees what is missing now, a new pickaxe included. Failing
      // without progress for any other reason ends the gathering.
      const after = shortfall(wanted, (await context.runtime.status()).inventory);
      if (units(after) >= units(missing) && errorCode(step.detail) !== "HOSTILE_CONTACT") return step;
      actions.push(`setback (${step.detail})`);
      continue;
    }
    actions.push(step.detail);
  }
  const left = shortfall(wanted, (await context.runtime.status()).inventory);
  return left.length === 0
    ? { status: "done", detail: actions.join(", ") }
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
  if (craftable) return "craft";
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
  /** The gathered leaves of the crafts, worked out again on each pass as the crafts grow. */
  let leaves = new Map<string, number>();
  const crafted = new Map<string, number>();
  const smelts = new Map<string, number>();
  const jobs = new Map<string, SmeltJob>();
  const gathered = (item: string, count: number) => {
    const block = MINED_FROM[item] ?? item;
    collect.set(block, (collect.get(block) ?? 0) + count);
  };
  const need = async (item: string, count: number): Promise<string | null> => {
    const how = await howToGet(runtime, item, knowledge);
    if (how === null) return `${item} is not a Minecraft item`;
    const into = how === "craft" ? crafted : how === "smelt" ? smelts : null;
    if (into === null) gathered(item, count);
    else into.set(item, (into.get(item) ?? 0) + count);
    return null;
  };
  for (const entry of missing) {
    const problem = await need(entry.item, entry.count);
    if (problem !== null) return problem;
  }
  // Furnace jobs and crafts each bring needs of their own (sand and fuel, a furnace, the leaves of the crafts), which
  // may be furnace jobs again (stone for smooth stone): settle them until nothing new comes up.
  let craftedSeen = "";
  for (let pass = 0; pass < 8 && (pass === 0 || jobs.size < smelts.size || craftedSeen !== signature(crafted)); pass += 1) {
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
    craftedSeen = signature(crafted);
    const batch = [...crafted].map(([item, count]) => ({ item, count }));
    if (batch.length === 0) continue;
    leaves = new Map();
    const needs = await runtime.craftingNeeds(withTools(batch, collect, inventory));
    if (needs.status === "uncraftable" || needs.status === "planner_failed" || needs.status === "unknown") {
      return `cannot work out how to craft ${describeMaterials(batch)}`;
    }
    for (const leaf of needs.missing) {
      // A leaf a furnace makes (glass for panes) is a furnace job; the others are gathered.
      if ((await howToGet(runtime, leaf.item, knowledge)) === "smelt") smelts.set(leaf.item, Math.max(smelts.get(leaf.item) ?? 0, leaf.count));
      else {
        const block = MINED_FROM[leaf.item] ?? leaf.item;
        leaves.set(block, (leaves.get(block) ?? 0) + leaf.count);
      }
    }
  }
  for (const [block, count] of leaves) collect.set(block, (collect.get(block) ?? 0) + count);
  const carries = (predicate: (name: string) => boolean) => inventory.some((stack) => predicate(stack.name));
  const pickaxeFirst = !carries((name) => name.endsWith("_pickaxe")) && [...collect.keys()].some((block) => PICKAXE_BLOCK.test(block));
  const tableFirst = (pickaxeFirst || crafted.size > 0) && !carries((name) => name === TABLE.item);
  return {
    collect,
    tableFirst,
    pickaxeFirst,
    craft: [...crafted].map(([item, count]) => ({ item, count })),
    smelt: [...jobs.values()],
  };
}

function signature(counts: ReadonlyMap<string, number>): string {
  return [...counts].map(([item, count]) => `${item}:${count}`).join(",");
}

/** `batch`, with the crafting table and wooden pickaxe it still has to make first, so their leaves are counted too. */
function withTools(batch: readonly ItemCount[], collect: ReadonlyMap<string, number>, inventory: Stacks): ItemCount[] {
  const carries = (predicate: (name: string) => boolean) => inventory.some((stack) => predicate(stack.name));
  const pickaxe = !carries((name) => name.endsWith("_pickaxe")) && ([...collect.keys()].some((block) => PICKAXE_BLOCK.test(block)) || batch.some(({ item }) => item === FURNACE));
  const table = !carries((name) => name === TABLE.item);
  return [...(table ? [TABLE] : []), ...(pickaxe ? [PICKAXE] : []), ...batch];
}

async function collectAll(context: GatherContext, targets: readonly (readonly [string, number])[], purpose: string): Promise<GatherResult> {
  const done: string[] = [];
  for (const [block, total] of targets) {
    for (let left = total; left > 0; left -= MAX_COLLECT) {
      const count = Math.min(left, MAX_COLLECT);
      const step = await act(context, "collect_block", { block_name: block, count }, `Gather ${count} ${block} for ${purpose}.`);
      if (step !== null) return step;
    }
    done.push(`collected ${total} ${block}`);
  }
  return { status: "done", detail: done.join(", ") };
}

/** Walks back near `home` when farther than {@link HOME_RANGE}; null when there (or back). */
async function goHome(context: GatherContext, home: Position, purpose: string, work: string): Promise<GatherResult | null> {
  const here = (await context.runtime.status()).position;
  if (Math.hypot(here.x - home.x, here.y - home.y, here.z - home.z) <= HOME_RANGE) return null;
  const target = { x: Math.floor(home.x), y: Math.floor(home.y), z: Math.floor(home.z), range: 1 };
  return act(context, "navigate", target, `Go back to the site to ${work} for ${purpose}.`);
}

/** Crafts with the carried table set down near `home`, walking back there first when needed. */
async function craftAtHome(context: GatherContext, items: readonly ItemCount[], purpose: string, home: Position, spent: Spent): Promise<GatherResult> {
  const back = await goHome(context, home, purpose, "craft");
  if (back !== null) return back;
  return craft(context, items, purpose, true, spent);
}

/** Smelts (at most one furnace load) in the carried furnace set down near `home`, walking back there first when needed. */
async function smeltAtHome(context: GatherContext, job: SmeltJob, purpose: string, home: Position): Promise<GatherResult> {
  const back = await goHome(context, home, purpose, "smelt");
  if (back !== null) return back;
  const count = Math.min(job.count, MAX_SMELT);
  const input = { item_name: job.input, count, fuel_item_name: job.fuel, temporary_workstation: true };
  const step = await act(context, "smelt_item", input, `Smelt ${count} ${job.input} into ${job.output} for ${purpose}.`);
  return step ?? { status: "done", detail: `smelted ${count} ${job.output} from ${job.input} with ${job.fuel}` };
}

/** Told the inventory just before and just after one craft or smelt. */
type Spent = (before: Stacks, after: Stacks) => void;

/** `withTable`: set the carried crafting table down for this batch and pick it up again. */
async function craft(context: GatherContext, items: readonly ItemCount[], purpose: string, withTable: boolean, spent: Spent): Promise<GatherResult> {
  const input = { items: items.map(({ item, count }) => ({ item_name: item, count })), ...(withTable && { temporary_workstation: true }) };
  const before = (await context.runtime.status()).inventory;
  const step = await act(context, "craft_item", input, `Craft ${describeMaterials(items)} for ${purpose}.`);
  if (step?.status !== "stopped") spent(before, (await context.runtime.status()).inventory);
  return step ?? { status: "done", detail: `crafted ${describeMaterials(items)}` };
}

/** Runs one action; null when it succeeded. */
async function act(context: GatherContext, tool: "collect_block" | "craft_item" | "smelt_item" | "navigate", input: Record<string, unknown>, rationale: string): Promise<GatherResult | null> {
  const outcome = await context.body.act(tool, input, rationale, { signal: context.signal });
  if (context.signal.aborted) return { status: "stopped" };
  if (outcome.status === "succeeded") return null;
  return { status: "failed", detail: outcome.error ?? `${tool} ${outcome.status}` };
}
