// Find material shape variants from crafting recipes and block states.
import minecraftData from "minecraft-data";
import { NEWEST_REGISTRY_VERSION } from "../newest-registry.ts";
import { SHAPES, type Shape } from "./blueprint.ts";

interface Registry {
  readonly items: Readonly<Record<string, { readonly name: string } | undefined>>;
  readonly itemsByName: Readonly<Record<string, { readonly id: number } | undefined>>;
  readonly blocksByName: Readonly<Record<string, { readonly states: readonly { readonly name: string }[] } | undefined>>;
  readonly recipes: Readonly<Record<string, readonly { readonly ingredients?: readonly (number | null)[]; readonly inShape?: readonly (readonly (number | null)[])[] }[] | undefined>>;
}

const newest = minecraftData(NEWEST_REGISTRY_VERSION) as unknown as Registry;
const cache = new WeakMap<Registry, Map<string, readonly string[]>>();

/** Recipe results made entirely from the supplied item, independent of the requested shapes. */
function candidatesOf(block: string, registry: Registry): readonly string[] {
  let entries = cache.get(registry);
  if (entries === undefined) { entries = new Map(); cache.set(registry, entries); }
  const cached = entries.get(block);
  if (cached !== undefined) return cached;
  const id = registry.itemsByName[block]?.id;
  const found = id === undefined ? [] : Object.entries(registry.recipes).flatMap(([result, recipes]) => {
    const name = registry.items[result]?.name;
    if (name === undefined || registry.blocksByName[name] === undefined) return [];
    return recipes?.some((recipe) => {
      const ingredients = [...(recipe.ingredients ?? []), ...(recipe.inShape ?? []).flat()].filter((item) => item !== null);
      return ingredients.length > 0 && ingredients.every((item) => item === id);
    }) ? [name] : [];
  });
  entries.set(block, found);
  return found;
}

/** Finds uniquely matching recipe results by their block state names, without assuming material names. */
export function shapeVariantsOf(block: string, like: Readonly<Partial<Record<Shape, string>>>, registry: Registry = newest): Partial<Record<Shape, string>> {
  const candidates = candidatesOf(block, registry);
  const result: Partial<Record<Shape, string>> = {};
  for (const shape of SHAPES) {
    const reference = like[shape];
    const states = reference === undefined ? undefined : registry.blocksByName[reference]?.states;
    if (states === undefined) continue;
    const signature = states.map((state) => state.name).sort().join(",");
    const matches = candidates.filter((name) => registry.blocksByName[name]!.states.map((state) => state.name).sort().join(",") === signature);
    if (matches.length === 1) result[shape] = matches[0];
  }
  return result;
}
