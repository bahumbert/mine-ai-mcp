// Getting items like a player (get_items): the gathering engine, then the walk back to where it started.
import { describeMaterials } from "../building/blueprint.ts";
import { gatherMaterials } from "../gathering/gather-materials.ts";
import type { SkillContext, SkillResult } from "../skills.ts";
import { makeRoom } from "./drop-items.ts";
import { GO_TO_RANGE, navigateInput } from "./positions.ts";
import { once } from "./single-action.ts";

/** `get_items` walks back to where it started when it ends farther than this. */
const RETURN_RANGE = 3;

/**
 * Gets `count` more of each item like a player (`gathering/`), then comes back to where it started: fetching is a
 * basic function; when and what to fetch is the model's choice (ADR-011).
 */
export async function getItems(context: SkillContext, items: readonly { readonly item: string; readonly count: number }[], purpose = `getting ${describeMaterials(items)}`): Promise<SkillResult> {
  const { position: start, inventory } = await context.runtime.status();
  const carried = (item: string) => inventory.filter((stack) => stack.name === item).reduce((sum, stack) => sum + stack.count, 0);
  const targets = items.map(({ item, count }) => ({ item, count: carried(item) + count }));
  // What it carried stays carried: crafting the new items must not quietly use up the others (the planks for the walls).
  const keep = [...new Set(inventory.map((stack) => stack.name))].map((item) => ({ item, count: carried(item) }));
  // What it is all for, so a line in chat says why (live 2026-10-02: "Gather 21 dirt for getting 1 stone_shovel, 21 dirt").
  const gathered = await gatherMaterials({ ...context, makeRoom: (inputs) => makeRoom(context, inputs) }, targets, purpose, start, keep);
  if (gathered.status !== "done") return gathered;
  const here = (await context.runtime.status()).position;
  if (Math.hypot(here.x - start.x, here.y - start.y, here.z - start.z) > RETURN_RANGE) {
    const back = await once(context, "navigate", navigateInput(start, GO_TO_RANGE), "Come back to where I started fetching.", "back");
    if (back.status === "stopped") return back;
    // The items are carried: that is the fetch done; the next step walks where it needs to (live 2026-10-10 run 10: a failed fetch looped the explore).
    if (back.status === "failed") return { status: "done", detail: `got ${describeMaterials(items)}; could not walk back: ${back.detail}` };
  }
  return { status: "done", detail: `got ${describeMaterials(items)}, now carrying ${describeMaterials(targets)} (${gathered.detail})` };
}
