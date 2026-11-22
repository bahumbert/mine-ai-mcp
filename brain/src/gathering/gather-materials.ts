// Gets a bill of items into the inventory the way a player would: round after round of collect, hunt, craft and smelt.
import { describeMaterials, shortfall } from "../building/blueprint.ts";
import { MAX_TOOL_LOSSES } from "../building/tool-loss.ts";
import type { Body } from "../body.ts";
import { ReplacementGuard, type ReplaceFirst } from "../kept-replacement.ts";
import { monotonicNow } from "../monotonic-clock.ts";
import { heldKinds, type OwedItem } from "../relations/items.ts";
import { mergedKeep, NO_KEEP, type WalkKeep } from "../walk-keep.ts";
import { errorCode, type BotRuntime, type ItemCount, type Position } from "../runtime-client.ts";
import { act } from "./gather-action.ts";
import { collectAll } from "./fetch-farther.ts";
import { huntAll } from "./hunt-drops.ts";
import { SAME_HOSTILE_LIMIT, type HostileInterruptions } from "./hostile-interruptions.ts";
import { howToGet, newKnowledge, RARE_DROP_BREAKS, rareNote, type Knowledge } from "./how-to-get.ts";
import { bagCounts, freeBag, heldWithReserve, keptWithOwed } from "./held-items.ts";
import { itemsNeeding } from "./made-from.ts";
import { planRound, readyCrafts, requiresTool, smeltReady, TABLE, toolMissing, type Round } from "./plan-round.ts";
import { carried, type Stacks } from "./stacks.ts";
import { craft, craftAtHome, smeltAtHome, type Site } from "./stations.ts";

/** Gather/craft/smelt rounds before giving up; a house takes about five (logs, table, pickaxe, stone, crafting),
 * replacing what crafting used up of the kept items (fences eat planks, planks eat logs) a few more, and glass panes
 * about ten (sand, logs, table, pickaxe, stone, furnace and fuel, glass, panes). */
const MAX_ROUNDS = 24;

export interface GatherContext {
  readonly runtime: BotRuntime;
  readonly body: Body;
  readonly signal: AbortSignal;
  /** The agent's interruptions, shared across gatherings so a new step cannot restart the same hostile loop. */
  readonly hostileInterruptions: HostileInterruptions;
  /**
   * Told what it starts doing now and what for, at each phase change (gathering, crafting, smelting), so the character
   * can say it (owner, 2026-10-02: under an order, she says what she does and why).
   */
  readonly progress?: (fact: string) => void;
  /** Told where a fetch is travelling to (a place it saw the block), and null when it arrived or gave up: getting nearer counts as progress for the no-gain stop. */
  readonly heading?: (target: { readonly x: number; readonly z: number } | null) => void;
  /** Drops what the work does not need to free a slot, never the `inputs` of the craft or smelt in hand; true when a slot is free now (unset: nothing is dropped unasked). */
  readonly makeRoom?: (inputs: ReadonlySet<string>) => Promise<boolean>;
  /** See {@link SkillContext.toolsLost}. */
  readonly toolsLost?: Set<string>;
  /** See {@link SkillContext.owed}: what the gathering and its crafts and smelts never spend. */
  readonly owed?: () => readonly OwedItem[];
  /** What the walks home and to a table between crafts must not lay (`navigate` `keep_items` and `reserve_items`: a stage's scaffold, see `getItems`' `walkKeep`). */
  readonly walkKeep?: WalkKeep;
  /** What the bag held when the fetch began (`gatherMaterials` sets it): the counts a walk that kept the fetched items by name keeps instead when it finds no way (`relaxedKeep`). */
  readonly walkCounts?: readonly ItemCount[];
  /**
   * Raw or made items a fetch must not craft or burn below these counts: the unfinished house's bill (`houseReserve(...).bill`,
   * the cells still wrong), so 26 logs for walls of 23 are replaced before the planks take them. Unset: raw items are crafting
   * stock (rule of 2026-10-04); a `means` fetch ignores it (plan 2026-11-14 Task 8).
   */
  readonly reserve?: readonly ItemCount[];
  /**
   * The fetch makes the means of the work in hand (a tool, a table, the fill): a craft may use kept items when no
   * replacement is near, and says so, instead of stopping with the replacement guard's sentence (plan 2026-11-14 Task 5).
   */
  readonly means?: true;
}

export type GatherResult =
  /** `usedOwn`: "used 3 oak_planks of what you carried" when crafts took items the character carried and none was near to replace them. */
  | { readonly status: "done"; readonly detail: string; readonly usedOwn?: string }
  | { readonly status: "failed"; readonly detail: string; readonly unavailable?: string }
  | { readonly status: "stopped" };

/** Told the inventory just before and just after one craft or smelt. */
export type Spent = (before: Stacks, after: Stacks) => void;

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
 * leaves it short of the others. Not a smelt: carried raw iron is there to be smelted and coal to be burnt (but not what an open trade owes, raw or not: it is kept and left out of the furnace jobs) (fuel
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
  const knowledge = newKnowledge(context.toolsLost);
  const owed = context.owed?.() ?? [];
  const inventory = (await context.runtime.status()).inventory;
  const made = await madeItems(context.runtime, keep, knowledge);
  // The raw items the unfinished house's bill names are kept like made ones, up to their count (a means fetch keeps none: it makes the tool the work needs).
  const reserve = context.means === true ? [] : context.reserve ?? [];
  const kept = keptWithOwed(made, heldWithReserve(owed, reserve, inventory));
  // Off the scaffold list only a kind with no spare: 64 carried with 2 owed still bridges.
  const items = [...bill, ...made].map((entry) => entry.item).concat([...heldKinds(owed, inventory)]);
  // Every walk of the fetch keeps these by name (the runtime's fallback scaffold ignores the policy list, so `withMaterialsKept` alone does not cover it).
  const walking = { ...context, reserve, walkKeep: mergedKeep(context.walkKeep ?? NO_KEEP, { items, reserve: [], scaffold: [] }), walkCounts: bagCounts(inventory) };
  return withMaterialsKept(context.runtime, items, () => gatherRounds(walking, bill, purpose, home, kept, knowledge));
}

/**
 * Materials being fetched are not scaffolding (live 2026-10-04: walking out of a cave, Tom's routes used 16 of the 36
 * cobblestone fetched for his house, and the build was short again): while `run` runs, those of `items` on the
 * runtime's scaffold list are taken off it, and the list is put back after (owner, 2026-10-07).
 */
export async function withMaterialsKept<T>(runtime: BotRuntime, items: readonly string[], run: () => Promise<T>): Promise<T> {
  if (items.length === 0) return run();
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

// Raw materials she carries are what crafting uses, as a player's would (except what an open trade owes: keptWithOwed, and
// what an unfinished house's bill names: `GatherContext.reserve`): only what was made (planks, stairs, glass)
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

/** What one round's step works from. `guard`: the kept items a craft is waiting on (short now, raised in `wanted`): only their own crafts run until they are carried. */
interface RoundInput {
  readonly context: GatherContext;
  readonly plan: Round;
  readonly inventory: Stacks;
  readonly missing: readonly ItemCount[];
  readonly purpose: string;
  readonly site: Site;
  readonly knowledge: Knowledge;
  readonly spent: Spent;
  readonly guard: ReplacementGuard;
}

/** The one step of a round (or why there is none): collect, hunt, make a table or tool, craft or smelt, whichever the plan puts first. */
async function roundStep(input: RoundInput): Promise<GatherResult | ReplaceFirst | string> {
  const { context, plan, inventory, missing, purpose, site, knowledge, spent, guard } = input;
  const ungated = [...plan.collect].filter(([block]) => toolMissing(block, inventory, knowledge) === null);
  const gated = [...plan.collect].filter(([block]) => toolMissing(block, inventory, knowledge) !== null);
  if (ungated.length > 0) return collectAll(context, ungated, purpose, knowledge);
  if (plan.hunt.size > 0) return huntAll(context, plan.hunt, purpose, knowledge);
  if (plan.tableFirst) return craft(context, [TABLE], purpose, false, spent);
  if (plan.toolFirst !== null) return craftAtHome(context, [{ item: plan.toolFirst, count: 1 }], purpose, site, spent);
  if (gated.length > 0) return collectAll(context, gated, purpose, knowledge);
  const ready = await readyCrafts(context.runtime, plan.craft);
  const job = plan.smelt.find((candidate) => smeltReady(candidate, freeBag(context, inventory)));
  // A kept item is replaced before the craft that uses it: the replacement alone, then the asked items (a single batch
  // would plan the asked item from the stock carried again). Tables and tools above keep their own path: a tool is the means to fetch.
  // A fetch that is itself the means of the work in hand (`means`) uses kept items when none can be got, and says so (`afterFailedRound`).
  const crafts = guard.allowed(ready);
  if (crafts.length > 0) return (context.means === true ? null : await guard.replaceFirst(context.runtime, crafts, inventory)) ?? craftAtHome(context, crafts, purpose, site, spent);
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
  const state: RoundState = { wanted: [...bill], usedOwn: [], actions: [], guard: new ReplacementGuard(bill, keep) };
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const inventory = (await context.runtime.status()).inventory;
    state.wanted = state.guard.release(state.wanted, inventory);
    const missing = shortfall(state.wanted, inventory);
    if (missing.length === 0) return finished(state, state.actions.length === 0 ? "had everything" : state.actions.join(", "));
    // A full bucket is no drop and no craft: a bucket (made like any item) filled at the liquid.
    const liquids = await context.runtime.toolEnum("use_bucket", "liquid");
    const filling = missing.find((entry) => bucketLiquid(entry.item, liquids) !== null);
    if (filling !== undefined && carried(inventory, "bucket") > 0) {
      const refused = await fillBucketRound(context, bucketLiquid(filling.item, liquids)!, state, purpose);
      if (refused !== null) return refused;
      continue;
    }
    const plan = await planRound(context.runtime, missing.map((entry) => entry === filling ? { item: "bucket", count: entry.count } : entry), inventory, freeBag(context, inventory), knowledge);
    if (typeof plan === "string") return failing(context, state, { status: "failed", detail: plan });

    // Only the craft itself counts as using kept items up: dirt spent as scaffold on the walk back home
    // is not fetched again (observed live 2026-10-01: a detour to collect 11 dirt).
    const spent: Spent = (before, after) => {
      state.wanted = keepWhatCraftingUsed(state.wanted, keep, before, after);
    };
    const stepped = await roundStep({ context, plan, inventory, missing, purpose, site, knowledge, spent, guard: state.guard });
    if (typeof stepped === "string") return failing(context, state, { status: "failed", detail: stepped });
    if (stepped.status === "replace_first") {
      // The craft would take kept items below their count: they are fetched first (raised, and the crafts held to
      // them until carried), then the craft runs on the spare. Raised already and still taken: the replacement's own craft uses them too.
      const raised = state.guard.raise(state.wanted, stepped);
      state.wanted = raised.wanted;
      if (!raised.raised) return failing(context, state, { status: "failed", detail: `the craft that makes ${stepped.items.map((entry) => entry.item).join(", ")} takes some of it again` });
      continue;
    }
    if (stepped.status === "stopped") return stepped;
    const next = await afterFailedRound({ context, step: stepped, plan, state, bill, keep, missing, knowledge });
    if (next === "continue") {
      // Slow progress needs a new decision even when this round gained items (P4-02c T3b, 2026-11-08).
      if (stepped.status === "failed" && errorCode(stepped.detail) === "NAVIGATION_SLOW") {
        const now = (await context.runtime.status()).inventory;
        const carriedNow = describeMaterials(bill.map((entry) => ({ item: entry.item, count: carried(now, entry.item) })).filter((entry) => entry.count > 0));
        return failing(context, state, { status: "failed", detail: `${stepped.detail} (carried now: ${carriedNow || "none of the requested items"}).` });
      }
      continue;
    }
    if (next !== null) return failing(context, state, next);
    state.actions.push(stepped.detail);
  }
  const left = shortfall(state.wanted, (await context.runtime.status()).inventory);
  return left.length === 0
    ? finished(state, state.actions.join(", "))
    : failing(context, state, { status: "failed", detail: `still missing ${describeMaterials(left)} after ${MAX_ROUNDS} rounds of gathering` });
}

/** What the rounds of one gathering have settled so far. */
interface RoundState {
  /** What the gathering still has to reach: the bill, raised back by what crafting used of the kept items. */
  wanted: ItemCount[];
  /** Her own items a craft used and that were not replaced, none being near. */
  readonly usedOwn: ItemCount[];
  readonly actions: string[];
  /** The kept items a craft waits on while they are short (see {@link RoundInput.guard}). */
  readonly guard: ReplacementGuard;
}

/** The gathering's result when it got everything, saying which of her own items it used up. */
function finished(state: RoundState, detail: string): GatherResult {
  const { usedOwn } = state;
  if (usedOwn.length === 0) return { status: "done", detail };
  const used = `used ${describeMaterials(usedOwn)} of what you carried`;
  return { status: "done", detail: `${detail}; ${used} (none near to replace it)`, usedOwn: used };
}

/** A failure while a kept item is still short says what the asked craft would take first, the failure's own words as the reason. */
async function failing(context: GatherContext, state: RoundState, result: GatherResult): Promise<GatherResult> {
  if (result.status !== "failed") return result;
  state.wanted = state.guard.release(state.wanted, (await context.runtime.status()).inventory);
  const detail = state.guard.failure(result.detail);
  return detail === null ? result : { ...result, detail };
}

/** Fills the carried bucket at `liquid`; null when filled (the next round goes on), else the result that ends the gathering. */
async function fillBucketRound(context: GatherContext, liquid: string, state: RoundState, purpose: string): Promise<GatherResult | null> {
  context.progress?.(`filling a bucket with ${liquid}, for ${purpose}`);
  const filled = await act(context, "use_bucket", { action: "fill", liquid }, `Fill a bucket with ${liquid}, for ${purpose}.`);
  if (filled !== null) return filled.status === "failed" && state.actions.length > 0 ? { status: "failed", detail: `got ${state.actions.join(", ")} so far; ${filled.detail}` } : filled;
  state.actions.push(`filled a bucket with ${liquid}`);
  return null;
}

/** What {@link afterFailedRound} judges: the round's step and what it ran on. */
interface RoundOutcome {
  readonly context: GatherContext;
  readonly step: Exclude<GatherResult, { readonly status: "stopped" }>;
  readonly plan: Round;
  readonly state: RoundState;
  readonly bill: readonly ItemCount[];
  readonly keep: readonly ItemCount[];
  readonly missing: readonly ItemCount[];
  readonly knowledge: Knowledge;
}

/**
 * What the gathering does after a round's step: "continue" with the next round (a setback was noted), a result that
 * ends it, or null when the step is simply done and its detail is the next action.
 */
async function afterFailedRound(outcome: RoundOutcome): Promise<"continue" | GatherResult | null> {
  const { context, step, plan, state, bill, keep, missing, knowledge } = outcome;
  const hostile = step.status === "failed" ? context.hostileInterruptions.note(step.detail) : null;
  if (hostile !== null && hostile.count >= SAME_HOSTILE_LIMIT) {
    const minutes = Math.round((monotonicNow() - hostile.firstAt) / 60_000);
    const detail = `stopped: ${hostile.name}#${hostile.id} at ${hostile.cell} interrupted gathering ${hostile.count} times in ${minutes} min and ${hostile.moved ? "keeps coming back" : "has not moved"}`;
    return failedWithProgress(context, state, bill, { status: "failed", detail }, knowledge);
  }
  const worn = wornOutTool(knowledge);
  if (worn !== null && step.status === "failed" && shortfall(state.wanted, (await context.runtime.status()).inventory).length > 0) {
    return { status: "failed", detail: `${worn}: stopping here; ${step.detail}` };
  }
  // A broken tool is replaced once: if the replacement cannot be made, the work goes on without it (a hand digs dirt).
  const remade = plan.toolFirstKind;
  if (remade !== null && knowledge.lost.delete(remade) && step.status === "failed") {
    // A block that drops nothing without the tool cannot go on without it: the gather ends here, not a round later.
    const now = (await context.runtime.status()).inventory;
    if ([...plan.collect.keys()].some((block) => requiresTool(block, now, knowledge))) return step;
    state.actions.push(`setback (could not make another ${plan.toolFirst}: ${step.detail}); going on without it`);
    return "continue";
  }
  const fruitless = rareFruitless(knowledge, (await context.runtime.status()).inventory);
  if (fruitless !== null) return { status: "failed", detail: fruitless };
  // What a craft took from her own items is replaced only from what is near: when the replacement is out of range,
  // she goes on with what was asked for and says what she used (live 2026-10-03: a wooden pickaxe used one of Vex's
  // own dark oak logs, and replacing it walked 700 blocks; with the range, it ended the fetch instead).
  // A kept item still short before a craft that would use it (guarded) is no craft's loss yet: that ends below, naming the craft.
  if (!state.guard.active && step.status === "failed" && /^no \S+ within /u.test(step.detail)) {
    const used = shortfall(keep, (await context.runtime.status()).inventory);
    if (used.length > 0 && state.wanted.some((entry) => !bill.some((asked) => asked.item === entry.item && asked.count >= entry.count))) {
      state.wanted = [...bill];
      state.usedOwn.push(...used);
      return "continue";
    }
  }
  if (step.status !== "failed") return null;
  // A setback that still got something (a pickaxe that broke after 15 of 16 stones) or a fight that interrupted
  // the work is survival as usual: the next round sees what is missing now, a new pickaxe included. Failing
  // without progress for any other reason ends the gathering.
  const after = shortfall(state.wanted, (await context.runtime.status()).inventory);
  // A tool that broke on the way (live 2026-10-04: Tom underground, his pickaxe gone) is a setback too: the next
  // round goes on without it, or makes another.
  if (units(after) >= units(missing) && !["HOSTILE_CONTACT", "TOOL_TIER_LOST"].includes(errorCode(step.detail) ?? "")) {
    return failedWithProgress(context, state, bill, step, knowledge);
  }
  state.actions.push(`setback (${step.detail})`);
  return "continue";
}

/** Keeps the items already carried visible when a later round ends the gathering (live 2026-10-10). */
async function failedWithProgress(context: GatherContext, state: RoundState, bill: readonly ItemCount[], step: GatherResult & { readonly status: "failed" }, knowledge: Knowledge): Promise<GatherResult> {
  const detail = `${step.detail}${unavailableItemsNote(step.unavailable, bill, knowledge)}`;
  if (state.actions.length === 0) return { ...step, detail };
  const now = (await context.runtime.status()).inventory;
  const carriedNow = describeMaterials(bill.map((entry) => ({ item: entry.item, count: carried(now, entry.item) })).filter((entry) => entry.count > 0));
  return { ...step, detail: `got ${state.actions.join(", ")} so far (carried now: ${carriedNow === "" ? "none of it" : carriedNow}); still missing ${describeMaterials(shortfall(state.wanted, now))}: ${detail}` };
}

/** Connect a failed source block to the asked crafts, using the drops learned during this gathering. */
function unavailableItemsNote(block: string | undefined, bill: readonly ItemCount[], knowledge: Knowledge): string {
  if (block === undefined) return "";
  const inputs = [block, ...[...knowledge.source].filter(([, source]) => source === block).map(([item]) => item)];
  const needed = itemsNeeding(inputs, bill);
  return needed.length === 0 ? "" : `; ${block} is for ${describeMaterials(needed)}`;
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

/** Says so when a tool class broke {@link MAX_TOOL_LOSSES} times in this gathering: a tool that keeps dying ends the step. */
function wornOutTool(knowledge: Knowledge): string | null {
  const worn = [...knowledge.losses].find(([, count]) => count >= MAX_TOOL_LOSSES);
  return worn === undefined ? null : `the ${worn[0]} was lost ${worn[1]} times in this step (remade ${worn[1] - 1} times)`;
}

function units(items: readonly ItemCount[]): number {
  return items.reduce((sum, { count }) => sum + count, 0);
}

/**
 * The liquid a full bucket `item` holds, among the `liquids` a `use_bucket` fill scoops (the contract's enum, read from
 * the runtime: a full bucket is named for its liquid); null for any other item (milk, powder snow, a fish...).
 */
function bucketLiquid(item: string, liquids: readonly string[]): string | null {
  return liquids.find((liquid) => item === `${liquid}_bucket`) ?? null;
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
