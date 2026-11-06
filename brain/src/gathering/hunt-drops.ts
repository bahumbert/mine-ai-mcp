// Hunting the mobs that drop what a gathering needs, with the next source tried when one fails.
import { act } from "./gather-action.ts";
import type { GatherContext, GatherResult } from "./gather-materials.ts";
import { huntSources, type Knowledge } from "./how-to-get.ts";

/** Hunts each item from its mob (`collect_mob_drop`: it finds, fights and picks up), one after the other. */
export async function huntAll(context: GatherContext, hunts: ReadonlyMap<string, { readonly mob: string; readonly count: number }>, purpose: string, knowledge: Knowledge): Promise<GatherResult> {
  const done: string[] = [];
  // No hostile mob spawns on a peaceful server (run 12: rotten_flesh and bone hunts ended in HUNT_TARGET_NOT_LOADED): refuse before walking.
  const hostile = [...hunts].find(([item]) => knowledge.mob.get(item)?.hostile === true);
  if (hostile !== undefined && (await context.runtime.status()).difficulty === "peaceful") {
    return { status: "failed", detail: `no ${hostile[1].mob} spawns on this peaceful server: ${hostile[0]} cannot be hunted here` };
  }
  for (const [item, { mob, count }] of hunts) {
    const hunted = await huntWithFallback(context, item, mob, count, purpose, knowledge);
    if (hunted.failure !== null) return hunted.failure;
    done.push(`got ${count} ${item} from ${hunted.mob}`);
  }
  return { status: "done", detail: done.join(", ") };
}

/**
 * Hunts `mob` for `item`; when that fails (no such mob loaded, a refusal), the next source of the runtime's order is
 * tried, each once per step, and the cache moves to the one that worked. The failure names every source tried.
 */
async function huntWithFallback(context: GatherContext, item: string, first: string, count: number, purpose: string, knowledge: Knowledge): Promise<{ readonly mob: string; readonly failure: GatherResult | null }> {
  const tried: string[] = [];
  let failure: GatherResult | null = null;
  for (let mob: string | undefined = first; mob !== undefined; ) {
    tried.push(mob);
    context.progress?.(`hunting ${mob} for ${count} ${item}, for ${purpose}`);
    failure = await act(context, "collect_mob_drop", { mob_name: mob, drop_name: item, count }, `Hunt ${mob} for ${count} ${item}, for ${purpose}.`);
    if (failure === null || failure.status === "stopped") break;
    const next = (await huntSources(context.runtime, item)).find((source) => !tried.includes(source.mob));
    if (next !== undefined) knowledge.mob.set(item, next);
    mob = next?.mob;
  }
  if (failure === null) return { mob: tried[tried.length - 1]!, failure };
  if (failure.status === "failed" && tried.length > 1) failure = { status: "failed", detail: `${failure.detail} (hunted ${tried.join(", then ")} for ${item}; none worked)` };
  return { mob: tried[tried.length - 1]!, failure };
}
