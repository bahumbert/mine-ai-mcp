/** Same need: the items the game's recipes swap for each other in one result's recipe, read from the registry's recipe data. */
import type minecraftData from "minecraft-data";

/** The version's data (`bot.registry` is a superset of it); a test passes `minecraftData(version)`. */
type Registry = ReturnType<typeof minecraftData>;

/**
 * Items that serve the same need as an item, read from the game's recipe data. The data lists one recipe per member of
 * a tag: the stone tools have one stone pickaxe recipe per stone tool material. Two items serve the same need for a
 * result when a recipe of that result, with one item's slots blanked, equals a sibling recipe with the other's blanked.
 * Built once per registry, not per call.
 */

/** The items that serve the same need as `item` (sorted, `item` excluded), and the results they serve it for (sorted). */
export interface SameNeed {
  readonly items: readonly string[];
  readonly results: readonly string[];
}

/** Per result id, per item id, the other item ids serving that item's need for the result. */
type NeedIndex = ReadonlyMap<number, ReadonlyMap<number, ReadonlySet<number>>>;

/** One recipe as the registry's data writes it: a shaped grid of ingredient ids (null: empty slot) or a shapeless bag. */
interface RecipeData {
  readonly inShape?: readonly (readonly unknown[])[];
  readonly ingredients?: readonly unknown[];
  readonly result?: unknown;
}

const NO_NEED: SameNeed = { items: [], results: [] };
const indexes = new WeakMap<Registry, NeedIndex>();

/** Items serving the same need as `item`; with `forResult`, only for that result. Unknown names serve no need. */
export function sameNeedItems(registry: Registry, item: string, forResult?: string): SameNeed {
  const itemId = registry.itemsByName[item]?.id;
  if (itemId === undefined) return NO_NEED;
  const onlyResult = forResult === undefined ? null : registry.itemsByName[forResult]?.id;
  if (onlyResult === undefined) return NO_NEED;

  const items = new Set<number>();
  const results = new Set<number>();
  for (const [resultId, byItem] of needIndexOf(registry)) {
    if (onlyResult !== null && resultId !== onlyResult) continue;
    const others = byItem.get(itemId);
    if (others === undefined) continue;
    results.add(resultId);
    for (const other of others) items.add(other);
  }
  return { items: namesOf(registry, items), results: namesOf(registry, results) };
}

function namesOf(registry: Registry, ids: ReadonlySet<number>): string[] {
  const names: string[] = [];
  for (const id of ids) {
    const name = registry.items[id]?.name;
    if (name !== undefined) names.push(name);
  }
  return names.sort();
}

function needIndexOf(registry: Registry): NeedIndex {
  const cached = indexes.get(registry);
  if (cached !== undefined) return cached;
  const index = buildNeedIndex(registry);
  indexes.set(registry, index);
  return index;
}

function buildNeedIndex(registry: Registry): NeedIndex {
  const index = new Map<number, Map<number, Set<number>>>();
  for (const [resultId, byShape] of groupRecipeShapes(registry)) {
    const byItem = needsOfResult(byShape);
    if (byItem.size > 0) index.set(resultId, byItem);
  }
  return index;
}

/** Per result: the blanked recipe shape -> the items that shape blanks. */
function groupRecipeShapes(registry: Registry): Map<number, Map<string, Set<number>>> {
  const groups = new Map<number, Map<string, Set<number>>>();
  for (const recipes of Object.values(registry.recipes) as RecipeData[][]) {
    for (const recipe of recipes) addRecipeShapes(groups, recipe);
  }
  return groups;
}

function addRecipeShapes(groups: Map<number, Map<string, Set<number>>>, recipe: RecipeData): void {
  const resultId = cellId(recipe.result);
  if (resultId === null) return;
  const byShape = groups.get(resultId) ?? new Map<string, Set<number>>();
  groups.set(resultId, byShape);
  for (const itemId of ingredientIds(recipe)) {
    const shape = blankedShape(recipe, itemId);
    const members = byShape.get(shape) ?? new Set<number>();
    byShape.set(shape, members);
    members.add(itemId);
  }
}

/** Of one result's shapes: per item, the other items whose shape matches it. */
function needsOfResult(byShape: ReadonlyMap<string, ReadonlySet<number>>): Map<number, Set<number>> {
  const byItem = new Map<number, Set<number>>();
  for (const members of byShape.values()) {
    if (members.size < 2) continue;
    for (const itemId of members) addOthers(byItem, itemId, members);
  }
  return byItem;
}

function addOthers(byItem: Map<number, Set<number>>, itemId: number, members: ReadonlySet<number>): void {
  const others = byItem.get(itemId) ?? new Set<number>();
  byItem.set(itemId, others);
  for (const other of members) if (other !== itemId) others.add(other);
}

/** The recipe's shape with every slot of `itemId` written `*`: shaped grids keep their positions, shapeless bags sort. */
function blankedShape(recipe: RecipeData, itemId: number): string {
  const token = (cell: unknown): string => {
    const id = cellId(cell);
    if (id === null) return "-";
    return id === itemId ? "*" : String(id);
  };
  if (recipe.inShape !== undefined) return recipe.inShape.map((row) => row.map(token).join(",")).join("/");
  return `bag:${(recipe.ingredients ?? []).map(token).sort().join(",")}`;
}

function ingredientIds(recipe: RecipeData): number[] {
  const cells = recipe.inShape !== undefined ? recipe.inShape.flat() : (recipe.ingredients ?? []);
  const ids = new Set<number>();
  for (const cell of cells) {
    const id = cellId(cell);
    if (id !== null) ids.add(id);
  }
  return [...ids];
}

/** An item id from the registry's data: a bare number, or an object with an `id` (a stack, a result). */
function cellId(cell: unknown): number | null {
  if (typeof cell === "number") return cell;
  if (typeof cell === "object" && cell !== null && "id" in cell && typeof cell.id === "number") return cell.id;
  return null;
}
