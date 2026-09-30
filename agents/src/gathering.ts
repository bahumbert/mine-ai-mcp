import { describeMaterials, shortfall } from "./building/blueprint.ts";
import type { Body } from "./body.ts";
import { errorCode, type BotRuntime, type ItemCount, type Position } from "./runtime-client.ts";

/** The runtime's `collect_block` limit per call (src/actions/collect-block/contract.ts `MAX_COLLECT_BLOCKS`). */
const MAX_COLLECT = 32;
/** Gather/craft rounds before giving up; a house takes about five (logs, table, pickaxe, stone, crafting). */
const MAX_ROUNDS = 10;
/** Farther than this from home, the bot walks back before setting its crafting table down. */
const HOME_RANGE = 3;

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

/** One round's work: what to collect (block → drops wanted), which tools are still to craft, what to craft. */
interface Round {
  readonly collect: ReadonlyMap<string, number>;
  readonly tableFirst: boolean;
  readonly pickaxeFirst: boolean;
  readonly craft: readonly ItemCount[];
}

const TABLE = { item: "crafting_table", count: 1 } as const;
const PICKAXE = { item: "wooden_pickaxe", count: 1 } as const;

/**
 * Gets every item of `bill` into the inventory the way a player would: chop and dig the raw materials, craft a
 * crafting table to carry and a wooden pickaxe when stone is needed, then craft the rest (the table is set down and
 * picked up again). The runtime's crafting planner picks the recipes; each round starts again from the real
 * inventory, so a recipe that used another wood than planned only costs another round. Crafting with the table
 * happens back at `home` (the build site: open ground), never at the bottom of the shaft the stone came from.
 */
export async function gatherMaterials(context: GatherContext, bill: readonly ItemCount[], purpose: string, home: Position): Promise<GatherResult> {
  const recipes = new Map<string, boolean>();
  const actions: string[] = [];
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const inventory = (await context.runtime.status()).inventory;
    const missing = shortfall(bill, inventory);
    if (missing.length === 0) return { status: "done", detail: actions.length === 0 ? "had everything" : actions.join(", ") };
    const plan = await planRound(context.runtime, missing, inventory, recipes);
    if (typeof plan === "string") return { status: "failed", detail: plan };

    const ungated = [...plan.collect].filter(([block]) => !PICKAXE_BLOCK.test(block));
    const gated = [...plan.collect].filter(([block]) => PICKAXE_BLOCK.test(block));
    let step: GatherResult;
    if (ungated.length > 0) step = await collectAll(context, ungated, purpose);
    else if (plan.tableFirst) step = await craft(context, [TABLE], purpose, false);
    else if (plan.pickaxeFirst) step = await craftAtHome(context, [PICKAXE], purpose, home);
    else if (gated.length > 0) step = await collectAll(context, gated, purpose);
    else step = await craftAtHome(context, plan.craft, purpose, home);
    if (step.status === "stopped") return step;
    if (step.status === "failed") {
      // A setback that still got something (a pickaxe that broke after 15 of 16 stones) or a fight that interrupted
      // the work is survival as usual: the next round sees what is missing now, a new pickaxe included. Failing
      // without progress for any other reason ends the gathering.
      const after = shortfall(bill, (await context.runtime.status()).inventory);
      if (units(after) >= units(missing) && errorCode(step.detail) !== "HOSTILE_CONTACT") return step;
      actions.push(`setback (${step.detail})`);
      continue;
    }
    actions.push(step.detail);
  }
  const left = shortfall(bill, (await context.runtime.status()).inventory);
  return left.length === 0
    ? { status: "done", detail: actions.join(", ") }
    : { status: "failed", detail: `still missing ${describeMaterials(left)} after ${MAX_ROUNDS} rounds of gathering` };
}

function units(items: readonly ItemCount[]): number {
  return items.reduce((sum, { count }) => sum + count, 0);
}

/** What the next rounds need, or why it cannot be done. */
async function planRound(
  runtime: BotRuntime,
  missing: readonly ItemCount[],
  inventory: readonly { readonly name: string; readonly count: number }[],
  recipes: Map<string, boolean>,
): Promise<Round | string> {
  const collect = new Map<string, number>();
  const add = (item: string, count: number) => {
    const block = MINED_FROM[item] ?? item;
    collect.set(block, (collect.get(block) ?? 0) + count);
  };
  const crafted: ItemCount[] = [];
  for (const entry of missing) {
    let craftable = recipes.get(entry.item);
    if (craftable === undefined) {
      const needs = await runtime.craftingNeeds([entry]);
      if (needs.status === "unknown") return `${entry.item} is not a Minecraft item`;
      craftable = needs.status !== "uncraftable";
      recipes.set(entry.item, craftable);
    }
    if (craftable) crafted.push(entry);
    else add(entry.item, entry.count);
  }
  const carries = (predicate: (name: string) => boolean) => inventory.some((stack) => predicate(stack.name));
  const pickaxeFirst = !carries((name) => name.endsWith("_pickaxe")) && [...collect.keys()].some((block) => PICKAXE_BLOCK.test(block));
  const tableFirst = (pickaxeFirst || crafted.length > 0) && !carries((name) => name === TABLE.item);
  const batch = [...(tableFirst ? [TABLE] : []), ...(pickaxeFirst ? [PICKAXE] : []), ...crafted];
  if (batch.length > 0) {
    const needs = await runtime.craftingNeeds(batch);
    if (needs.status === "uncraftable" || needs.status === "planner_failed" || needs.status === "unknown") {
      return `cannot work out how to craft ${describeMaterials(batch)}`;
    }
    for (const leaf of needs.missing) add(leaf.item, leaf.count);
  }
  return { collect, tableFirst, pickaxeFirst, craft: crafted };
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

/** Crafts with the carried table set down near `home`, walking back there first when needed. */
async function craftAtHome(context: GatherContext, items: readonly ItemCount[], purpose: string, home: Position): Promise<GatherResult> {
  const here = (await context.runtime.status()).position;
  if (Math.hypot(here.x - home.x, here.y - home.y, here.z - home.z) > HOME_RANGE) {
    const target = { x: Math.floor(home.x), y: Math.floor(home.y), z: Math.floor(home.z), range: 1 };
    const back = await act(context, "navigate", target, `Go back to the site to craft for ${purpose}.`);
    if (back !== null) return back;
  }
  return craft(context, items, purpose, true);
}

/** `withTable`: set the carried crafting table down for this batch and pick it up again. */
async function craft(context: GatherContext, items: readonly ItemCount[], purpose: string, withTable: boolean): Promise<GatherResult> {
  const input = { items: items.map(({ item, count }) => ({ item_name: item, count })), ...(withTable && { temporary_workstation: true }) };
  const step = await act(context, "craft_item", input, `Craft ${describeMaterials(items)} for ${purpose}.`);
  return step ?? { status: "done", detail: `crafted ${describeMaterials(items)}` };
}

/** Runs one action; null when it succeeded. */
async function act(context: GatherContext, tool: "collect_block" | "craft_item" | "navigate", input: Record<string, unknown>, rationale: string): Promise<GatherResult | null> {
  const outcome = await context.body.act(tool, input, rationale, { signal: context.signal });
  if (context.signal.aborted) return { status: "stopped" };
  if (outcome.status === "succeeded") return null;
  return { status: "failed", detail: outcome.error ?? `${tool} ${outcome.status}` };
}
