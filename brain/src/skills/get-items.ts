// Getting items like a player (get_items): the gathering engine, then the walk back to where it started.
import { describeMaterials } from "../building/blueprint.ts";
import { gatherMaterials } from "../gathering/gather-materials.ts";
import { HostileInterruptions } from "../gathering/hostile-interruptions.ts";
import { isWetSite } from "../gathering/stations.ts";
import { monotonicNow } from "../monotonic-clock.ts";
import { carriedOf } from "../relations/items.ts";
import type { ItemCount } from "../runtime-client.ts";
import type { SkillContext, SkillResult } from "../skills.ts";
import { mergedKeep, NO_KEEP, walkKeepInput, walkRelaxing, type WalkKeep } from "../walk-keep.ts";
import { awayFrom, backStep, failedFetchNote, houseScaffoldKeep } from "../walks.ts";
import { makeRoom } from "./drop-items.ts";
import { GO_TO_RANGE, navigateInput } from "./positions.ts";
import { once } from "./single-action.ts";

/** What a fetch is asked beyond its items: why, what its walks keep, what its crafts and burns never spend, and whether it makes the means of the work in hand. */
interface GetItemsOptions {
  readonly purpose?: string;
  readonly walkKeep?: WalkKeep;
  readonly reserve?: readonly ItemCount[];
  readonly means?: true;
}

/**
 * Gets `count` more of each item like a player (`gathering/`), then comes back to where it started: fetching is a
 * basic function; when and what to fetch is the model's choice (ADR-011).
 */
export async function getItems(context: SkillContext, items: readonly { readonly item: string; readonly count: number }[], options: GetItemsOptions = {}): Promise<SkillResult> {
  const { purpose = `getting ${describeMaterials(items)}`, reserve, means, walkKeep = means === true ? await houseScaffoldKeep(context) : NO_KEEP } = options; // a means fetch keeps no bill; its walks keep the house's scaffold
  const { position: start, inventory, dimension: startDimension } = await context.runtime.status();
  const targets = items.map(({ item, count }) => ({ item, count: carriedOf(inventory, item) + count }));
  // What it carried stays carried: crafting the new items must not quietly use up the others (the planks for the walls).
  const keep = [...new Set(inventory.map((stack) => stack.name))].map((item) => ({ item, count: carriedOf(inventory, item) }));
  // What it is all for, so a line in chat says why (live 2026-10-02: "Gather 21 dirt for getting 1 stone_shovel, 21 dirt").
  const hostileInterruptions = context.hostileInterruptions ?? new HostileInterruptions(monotonicNow);
  const gathered = await gatherMaterials({ ...context, hostileInterruptions, makeRoom: (inputs) => makeRoom(context, inputs), walkKeep, ...(reserve !== undefined && { reserve }), ...(means !== undefined && { means }) }, targets, purpose, start, keep);
  const after = await context.runtime.status();
  if (gathered.status === "failed") return { ...gathered, detail: `${gathered.detail}${failedFetchNote(start, startDimension, after)}` };
  if (gathered.status !== "done") return gathered;
  const detail = `got ${describeMaterials(items)}, now carrying ${describeMaterials(targets)} (${gathered.detail})`;
  const usedOwn = gathered.usedOwn !== undefined ? { usedOwn: gathered.usedOwn } : {};
  if (awayFrom(start, after.position)) {
    const stayDry = await isWetSite(context.runtime, start) && !await isWetSite(context.runtime, after.position);
    if (context.signal.aborted) return { status: "stopped" };
    if (stayDry) return { status: "done", detail: `${detail}; stayed on dry land: where the fetch started is in water`, ...usedOwn };
    // The fetched items are kept by name; one retry rule (`relaxedKeep`) when that leaves no way: what was carried before the fetch stays kept by count.
    const kept = mergedKeep(walkKeep, { items: items.map(({ item }) => item), reserve: [], scaffold: [] });
    const walkBack = (walkKept: WalkKeep) => once(context, "navigate", { ...navigateInput(start, GO_TO_RANGE), ...walkKeepInput(walkKept) }, "Come back to where I started fetching.", "back");
    const back = await walkRelaxing(context, kept, keep, walkBack, (result) => result.status === "failed" && result.detail.startsWith("[NAVIGATION_STOPPED]"));
    if (back.status === "stopped") return back;
    // The items are carried: that is the fetch done; the next step walks where it needs to (live 2026-10-10 run 10: a failed fetch looped the explore).
    if (back.status === "failed") return { status: "done", detail: `got ${describeMaterials(items)}; could not walk back: ${back.detail}; ${backStep(start)} tries again`, ...usedOwn };
  }
  return { status: "done", detail, ...usedOwn };
}
