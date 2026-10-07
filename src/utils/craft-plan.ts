import type { Bot } from "mineflayer";

export interface CraftTarget {
  readonly id: number;
  readonly name: string;
  readonly count: number;
}

export interface CraftMaterial {
  readonly item: string;
  readonly count: number;
}

export interface CraftStep {
  readonly item: string;
  readonly count: number;
  readonly applications: number;
  readonly ingredients: CraftMaterial[];
  readonly requiresCraftingTable: boolean;
}

export interface CraftPlanEvidence {
  readonly status: "ready" | "missing_materials" | "uncraftable" | "planner_failed";
  readonly steps: CraftStep[];
  /** Every raw leaf material the selected recipe paths require, whether carried or missing. */
  readonly requiredMaterials: CraftMaterial[];
  /** Carried leaf materials the simulated batch reserves before any crafting begins. */
  readonly carriedMaterials: CraftMaterial[];
  readonly missingMaterials: CraftMaterial[];
  readonly requiresCraftingTable: boolean;
  readonly tree: string;
}

type MineflayerRecipe = ReturnType<Bot["recipesAll"]>[number];

export interface CraftApplication {
  readonly recipe: MineflayerRecipe;
  readonly applications: number;
}

export type CraftPreparation =
  | { readonly kind: "ready"; readonly plan: CraftPlanEvidence; readonly applications: readonly CraftApplication[] }
  | { readonly kind: "missing_materials"; readonly plan: CraftPlanEvidence }
  | { readonly kind: "uncraftable"; readonly plan: CraftPlanEvidence; readonly items: readonly string[] }
  | { readonly kind: "planner_failed"; readonly plan: CraftPlanEvidence; readonly items: readonly string[] };

export interface CraftPlanOptions {
  /**
   * Materials to choose, in this order, where recipes accept several and none is carried: the logs that grow nearby
   * rather than the first wood in registry order. Unknown names are ignored.
   */
  readonly prefer?: readonly string[];
}

interface PlanningState {
  readonly available: Map<number, number>;
  readonly craftedSurplus: Map<number, number>;
  readonly required: Map<number, number>;
  readonly carried: Map<number, number>;
  readonly missing: Map<number, number>;
  readonly applications: CraftApplication[];
  /** Item id -> rank among the caller's preferred materials (0 first); shared, never copied. */
  readonly prefer: ReadonlyMap<number, number>;
}

type ItemSource =
  | { readonly kind: "inventory" }
  | { readonly kind: "missing"; readonly count: number }
  | { readonly kind: "recipe"; readonly ingredients: readonly PlannedItem[] };

interface PlannedItem {
  readonly id: number;
  readonly count: number;
  readonly sources: readonly ItemSource[];
}

interface PlannedCandidate {
  readonly state: PlanningState;
  readonly item: PlannedItem;
}

/** A requirement no recipe path can make without needing one of these items, already being planned above it. */
interface PlanCycle {
  readonly cycle: ReadonlySet<number>;
}

interface PlannedTarget {
  readonly target: CraftTarget;
  readonly root?: PlannedItem;
}

function copyState(state: PlanningState): PlanningState {
  return {
    available: new Map(state.available),
    craftedSurplus: new Map(state.craftedSurplus),
    required: new Map(state.required),
    carried: new Map(state.carried),
    missing: new Map(state.missing),
    applications: [...state.applications],
    prefer: state.prefer,
  };
}

function addCount(counts: Map<number, number>, itemId: number, count: number): void {
  counts.set(itemId, (counts.get(itemId) ?? 0) + count);
}

function itemName(bot: Bot, itemId: number): string {
  return bot.registry.items[itemId]?.name ?? `item_${itemId}`;
}

function recipeInputs(recipe: MineflayerRecipe): readonly { id: number; count: number }[] {
  return recipe.delta.filter((item) => item.count < 0);
}

/**
 * Lower is better: units missing, then units missing of materials the plan does
 * not already take from the inventory, then kinds missing, then crafts. The
 * second term breaks the tie between wood families: two oak logs short of a
 * table and a pickaxe were reported as one missing pale_oak_log, the first
 * planks recipe in registry order, and a gatherer then looked for pale oak in
 * an oak forest. A material it already carries is the one it can find again. Carrying none of them, the caller's
 * preferred materials come next, in its order (live 3 October: carrying nothing, a stone pickaxe was still "3
 * pale_oak_log", and the gatherer walked 900 blocks for them past oak and birch).
 */
function missingScore(state: PlanningState): readonly [number, number, number, number, number] {
  let missingUnits = 0;
  let unfamiliarUnits = 0;
  let unpreferred = 0;
  for (const [itemId, count] of state.missing) {
    missingUnits += count;
    if (!state.carried.has(itemId)) unfamiliarUnits += count;
    unpreferred += count * (state.prefer.get(itemId) ?? state.prefer.size);
  }
  return [missingUnits, unfamiliarUnits, unpreferred, state.missing.size, state.applications.length];
}

function isBetterCandidate(candidate: PlannedCandidate, current: PlannedCandidate | null): boolean {
  if (!current) return true;
  const candidateScore = missingScore(candidate.state);
  const currentScore = missingScore(current.state);
  for (let index = 0; index < candidateScore.length; index += 1) {
    if (candidateScore[index] !== currentScore[index]) return candidateScore[index] < currentScore[index];
  }
  return false;
}

/**
 * Plan one requirement against a simulated inventory and retain its selected recipe tree. A recipe path that needs an
 * item already being planned above it is a loop and is skipped; when every recipe of an ingredient loops back to that
 * ingredient itself (iron ingots only craft out of nuggets and blocks made of ingots), it is a missing material, as an
 * item without any recipe is. A requested item itself never is (coal only crafts out of coal: it is not craftable).
 */
function planNeededItem(
  bot: Bot,
  initial: PlanningState,
  itemId: number,
  count: number,
  ancestors: ReadonlySet<number>,
  useInventory: boolean,
): PlannedCandidate | PlanCycle {
  // Needing an item already being planned above is a loop, carried or not: carried wheat spent on a hay block to
  // craft wheat back is a round trip (live 2026-10-03).
  if (ancestors.has(itemId)) return { cycle: new Set([itemId]) };
  const state = copyState(initial);
  const sources: ItemSource[] = [];
  let remaining = count;

  if (useInventory) {
    const available = state.available.get(itemId) ?? 0;
    const consumed = Math.min(available, remaining);
    if (consumed > 0) {
      state.available.set(itemId, available - consumed);
      const crafted = state.craftedSurplus.get(itemId) ?? 0;
      const consumedSurplus = Math.min(crafted, consumed);
      state.craftedSurplus.set(itemId, crafted - consumedSurplus);
      const consumedInventory = consumed - consumedSurplus;
      if (consumedInventory > 0) {
        addCount(state.required, itemId, consumedInventory);
        addCount(state.carried, itemId, consumedInventory);
      }
      sources.push({ kind: "inventory" });
      remaining -= consumed;
    }
  }

  if (remaining === 0) return { state, item: { id: itemId, count, sources } };

  const missingLeaf = (): PlannedCandidate => {
    addCount(state.required, itemId, remaining);
    addCount(state.missing, itemId, remaining);
    sources.push({ kind: "missing", count: remaining });
    return { state, item: { id: itemId, count, sources } };
  };
  // A recolouring recipe (a bed or wool dyed into another colour) makes nothing new: planned, it sent a bot after
  // black wool and lily of the valley for its first white bed (live 2026-10-04). Kept only when it is the sole recipe.
  const allRecipes = bot.recipesAll(itemId, null, true);
  const fresh = allRecipes.filter((recipe) => !isRecolouring(bot, itemId, recipe));
  const recipes = fresh.length > 0 ? fresh : allRecipes;
  if (recipes.length === 0) return missingLeaf();

  const nextAncestors = new Set(ancestors).add(itemId);
  let best: PlannedCandidate | null = null;
  const loopsTo = new Set<number>();

  for (const recipe of recipes) {
    const applications = Math.ceil(remaining / recipe.result.count);
    let candidateState = copyState(state);
    const ingredients: PlannedItem[] = [];
    let cyclic = false;

    for (const ingredient of recipeInputs(recipe)) {
      const planned = planNeededItem(
        bot,
        candidateState,
        ingredient.id,
        -ingredient.count * applications,
        nextAncestors,
        true,
      );
      if ("cycle" in planned) {
        for (const id of planned.cycle) loopsTo.add(id);
        cyclic = true;
        break;
      }
      candidateState = planned.state;
      ingredients.push(planned.item);
    }
    if (cyclic) continue;

    candidateState.applications.push({ recipe, applications });
    const surplus = recipe.result.count * applications - remaining;
    if (surplus > 0) {
      addCount(candidateState.available, itemId, surplus);
      addCount(candidateState.craftedSurplus, itemId, surplus);
    }

    const candidate: PlannedCandidate = {
      state: candidateState,
      item: { id: itemId, count, sources: [...sources, { kind: "recipe", ingredients }] },
    };
    if (isBetterCandidate(candidate, best)) best = candidate;
  }

  if (best !== null) return best;
  loopsTo.delete(itemId);
  if (loopsTo.size === 0 && ancestors.size > 0) return missingLeaf();
  return { cycle: loopsTo.size > 0 ? loopsTo : new Set([itemId]) };
}

function materials(bot: Bot, counts: ReadonlyMap<number, number>): CraftMaterial[] {
  return [...counts]
    .filter(([, count]) => count > 0)
    .map(([id, count]) => ({ item: itemName(bot, id), count }))
    .sort((left, right) => left.item.localeCompare(right.item));
}

function steps(bot: Bot, applications: readonly CraftApplication[]): CraftStep[] {
  return applications.map(({ recipe, applications: count }) => ({
    item: itemName(bot, recipe.result.id),
    count: recipe.result.count * count,
    applications: count,
    ingredients: recipeInputs(recipe).map((ingredient) => ({
      item: itemName(bot, ingredient.id),
      count: -ingredient.count * count,
    })),
    requiresCraftingTable: recipe.requiresTable,
  }));
}

function recipeTree(bot: Bot, targets: readonly PlannedTarget[]): string {
  const sections = targets.map(({ target, root }) => {
    const lines = [`${target.name} x${target.count}`];
    if (!root) return lines[0];

    const appendIngredients = (item: PlannedItem, prefix: string): void => {
      const ingredients = item.sources.flatMap((source) => (source.kind === "recipe" ? source.ingredients : []));
      ingredients.forEach((ingredient, index) => {
        const last = index === ingredients.length - 1;
        const missing = ingredient.sources
          .filter((source) => source.kind === "missing")
          .reduce((total, source) => total + source.count, 0);
        lines.push(
          `${prefix}${last ? "└─" : "├─"} ${itemName(bot, ingredient.id)} x${ingredient.count}${missing > 0 ? ` - missing ${missing}` : ""}`,
        );
        appendIngredients(ingredient, `${prefix}${last ? "   " : "│  "}`);
      });
    };

    appendIngredients(root, "");
    return lines.join("\n");
  });
  return sections.join("\n\n");
}

function evidence(
  bot: Bot,
  status: CraftPlanEvidence["status"],
  state: PlanningState,
  targets: readonly PlannedTarget[],
): CraftPlanEvidence {
  return {
    status,
    steps: steps(bot, state.applications),
    requiredMaterials: materials(bot, state.required),
    carriedMaterials: materials(bot, state.carried),
    missingMaterials: materials(bot, state.missing),
    requiresCraftingTable: state.applications.some(({ recipe }) => recipe.requiresTable),
    tree: recipeTree(bot, targets),
  };
}

/**
 * Plan an all-or-nothing crafting batch without mutating the bot.
 * Earlier targets reserve their requested output while intermediate surplus
 * remains available to later targets.
 */
export function planCraftingFromInventory(bot: Bot, targets: readonly CraftTarget[], options: CraftPlanOptions = {}): CraftPreparation {
  const available = new Map<number, number>();
  for (const item of bot.inventory.items()) addCount(available, item.type, item.count);
  const prefer = new Map<number, number>();
  for (const name of options.prefer ?? []) {
    const id = bot.registry.itemsByName[name]?.id;
    if (id !== undefined && !prefer.has(id)) prefer.set(id, prefer.size);
  }
  let state: PlanningState = {
    prefer,
    available,
    craftedSurplus: new Map(),
    required: new Map(),
    carried: new Map(),
    missing: new Map(),
    applications: [],
  };
  const plannedTargets: PlannedTarget[] = [];
  const uncraftable: string[] = [];
  const plannerFailures: string[] = [];

  for (const target of targets) {
    if (bot.recipesAll(target.id, null, true).length === 0) {
      uncraftable.push(target.name);
      plannedTargets.push({ target });
      continue;
    }

    const planned = planNeededItem(bot, state, target.id, target.count, new Set(), false);
    if ("cycle" in planned) {
      plannerFailures.push(target.name);
      plannedTargets.push({ target });
      continue;
    }
    state = planned.state;
    plannedTargets.push({ target, root: planned.item });
  }

  if (uncraftable.length > 0) {
    return {
      kind: "uncraftable",
      items: uncraftable,
      plan: evidence(bot, "uncraftable", state, plannedTargets),
    };
  }
  if (plannerFailures.length > 0) {
    return {
      kind: "planner_failed",
      items: plannerFailures,
      plan: evidence(bot, "planner_failed", state, plannedTargets),
    };
  }
  if (state.missing.size > 0) {
    return { kind: "missing_materials", plan: evidence(bot, "missing_materials", state, plannedTargets) };
  }
  return {
    kind: "ready",
    plan: evidence(bot, "ready", state, plannedTargets),
    applications: state.applications,
  };
}

/** The family of an item named with its colour: "bed" for white_bed, "wool" for red_wool; null for others. */
const COLOURS = ["white", "orange", "magenta", "light_blue", "yellow", "lime", "pink", "gray", "light_gray", "cyan", "purple", "blue", "brown", "green", "red", "black"];
function colouredFamily(name: string): string | null {
  const colour = [...COLOURS].sort((a, b) => b.length - a.length).find((candidate) => name.startsWith(`${candidate}_`));
  return colour === undefined ? null : name.slice(colour.length + 1);
}

/** Whether a recipe for a coloured item takes another of the same family (a black bed dyed white). */
function isRecolouring(bot: Bot, itemId: number, recipe: Parameters<typeof recipeInputs>[0]): boolean {
  const family = colouredFamily(bot.registry.items[itemId]?.name ?? "");
  if (family === null) return false;
  return recipeInputs(recipe).some((ingredient) => {
    const name = bot.registry.items[ingredient.id]?.name ?? "";
    return name !== "" && (name === family || colouredFamily(name) === family);
  });
}
