// Requested items that can be crafted from an unavailable input.
import minecraftData from "minecraft-data";
import { NEWEST_REGISTRY_VERSION } from "../newest-registry.ts";
import type { ItemCount } from "../runtime-client.ts";

interface RecipeRegistry {
  readonly itemsByName: Readonly<Record<string, { readonly id: number } | undefined>>;
  readonly recipes: Readonly<Record<string, readonly {
    readonly ingredients?: readonly (number | null)[];
    readonly inShape?: readonly (readonly (number | null)[])[];
  }[] | undefined>>;
}

/** The newest shipped crafting data, as with the brain's boat recipe lookup. */
function newestRecipes(): RecipeRegistry {
  return minecraftData(NEWEST_REGISTRY_VERSION) as unknown as RecipeRegistry;
}

/** Asked items reachable from any input through crafting ingredients only, never smelting. */
export function itemsNeeding(inputs: readonly string[], wanted: readonly ItemCount[], registry = newestRecipes()): ItemCount[] {
  const sources = new Set(inputs.flatMap((input) => {
    const item = registry.itemsByName[input];
    return item === undefined ? [] : [item.id];
  }));
  return wanted.filter(({ item }) => {
    const id = registry.itemsByName[item]?.id;
    return id !== undefined && needsInput(id, sources, registry);
  });
}

/** Walk every recipe's ingredients, including cycles, without a recipe-depth cutoff. */
function needsInput(item: number, sources: ReadonlySet<number>, registry: RecipeRegistry): boolean {
  const pending = [item];
  const visited = new Set<number>();
  while (pending.length > 0) {
    const next = pending.pop()!;
    if (sources.has(next)) return true;
    if (visited.has(next)) continue;
    visited.add(next);
    const ingredients = (registry.recipes[String(next)] ?? []).flatMap((recipe) => [
      ...(recipe.ingredients ?? []), ...(recipe.inShape ?? []).flat(),
    ]);
    for (const ingredient of ingredients) {
      if (ingredient !== null && !visited.has(ingredient)) pending.push(ingredient);
    }
  }
  return false;
}
