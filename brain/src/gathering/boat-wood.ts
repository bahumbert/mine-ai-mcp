// The boat a fetch names across water: the one the wood she carries makes.
import { boatsOfWood } from "../boats.ts";
import type { BotRuntime } from "../runtime-client.ts";

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
export async function boatToMake(runtime: BotRuntime): Promise<string> {
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
