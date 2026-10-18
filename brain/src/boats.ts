import minecraftData from "minecraft-data";
import type { BotRuntime } from "./runtime-client.ts";

/** The recipe data of minecraft-data's newest registry (the server's own version is confirmed by the craft planner). */
interface Registry {
  readonly items: Readonly<Record<string, { readonly name: string } | undefined>>;
  readonly itemsByName: Readonly<Record<string, { readonly id: number } | undefined>>;
  readonly recipes: Readonly<Record<string, readonly { readonly ingredients?: readonly (number | null)[]; readonly inShape?: readonly (readonly (number | null)[])[] }[] | undefined>>;
}

const REGISTRY_VERSION = (minecraftData as unknown as { readonly supportedVersions: { readonly pc: readonly string[] } }).supportedVersions.pc.at(-1) ?? "";

/** A boat of the game and the log its planks are made from (null: its planks come from no single item). */
interface BoatRecipe {
  readonly boat: string;
  readonly planks: string;
  readonly log: string | null;
}

let known: readonly BoatRecipe[] | null = null;

/**
 * The craftable boats and rafts (the convention the runtime uses to tell a boat item: `_boat` / `_raft`), each with the
 * planks its recipe takes and the one item those planks are made from, all from the recipe data.
 */
function boatRecipes(): readonly BoatRecipe[] {
  if (known !== null) return known;
  const data = minecraftData(REGISTRY_VERSION) as unknown as Registry | undefined;
  const found: BoatRecipe[] = [];
  if (data !== undefined) {
    const ingredients = (id: string): Set<string> => {
      const names = new Set<string>();
      for (const recipe of data.recipes[id] ?? []) {
        for (const ingredient of [...(recipe.ingredients ?? []), ...(recipe.inShape ?? []).flat()]) {
          const name = ingredient === null ? undefined : data.items[String(ingredient)]?.name;
          if (name !== undefined) names.add(name);
        }
      }
      return names;
    };
    for (const [name, item] of Object.entries(data.itemsByName)) {
      if (item === undefined || !/_(boat|raft)$/u.test(name)) continue;
      const planks = [...ingredients(String(item.id))];
      // A boat is made of one kind of planks; a chest boat of a boat and a chest.
      if (planks.length !== 1) continue;
      const logs = [...ingredients(String(data.itemsByName[planks[0]!]?.id))];
      found.push({ boat: name, planks: planks[0]!, log: logs.length === 1 ? logs[0]! : null });
    }
  }
  known = found;
  return found;
}

const tagsOfName = new WeakMap<BotRuntime, Map<string, readonly string[]>>();

async function tagsOf(runtime: BotRuntime, names: readonly string[]): Promise<ReadonlyMap<string, readonly string[]>> {
  const cache = tagsOfName.get(runtime) ?? new Map<string, readonly string[]>();
  tagsOfName.set(runtime, cache);
  const unknown = names.filter((name) => !cache.has(name));
  if (unknown.length > 0) {
    const kinds = await runtime.blockKinds(unknown);
    for (const name of unknown) cache.set(name, kinds[name]?.tags ?? []);
  }
  return cache;
}

/**
 * The boats whose recipe takes the planks of `wood` (a log, stem, stripped one, wood block or planks): its planks are
 * the recipe's own when it is planks, else those whose source item shares with `wood` a block tag that no other tree's
 * source has (`oak_logs` holds oak_log and stripped_oak_log; `logs` is shared by every tree, so it says nothing). A wood
 * without a boat (crimson_stem) has none, and nothing is asked of the runtime for it.
 */
export async function boatsOfWood(runtime: BotRuntime, wood: string): Promise<readonly string[]> {
  const recipes = boatRecipes();
  const direct = recipes.filter((recipe) => recipe.planks === wood || recipe.log === wood).map((recipe) => recipe.boat);
  if (direct.length > 0) return direct;
  const sources = [...new Set(recipes.flatMap((recipe) => recipe.log === null ? [] : [recipe.log]))];
  const tags = await tagsOf(runtime, [wood, ...sources]);
  const own = tags.get(wood) ?? [];
  const specific = own.filter((tag) => sources.filter((source) => tags.get(source)?.includes(tag)).length === 1);
  return recipes.filter((recipe) => recipe.log !== null && specific.some((tag) => tags.get(recipe.log!)?.includes(tag))).map((recipe) => recipe.boat);
}
