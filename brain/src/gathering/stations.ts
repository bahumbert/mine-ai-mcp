// Crafting and smelting at the site's workstations: walking to a placed table or furnace, or setting a carried one down.
import { describeMaterials } from "../building/blueprint.ts";
import type { FoundBlock, ItemCount, Position, BotRuntime } from "../runtime-client.ts";
import { act } from "./gather-action.ts";
import type { GatherContext, GatherResult, Spent } from "./gather-materials.ts";
import { MAX_SMELT, type SmeltJob } from "./plan-round.ts";

/** Farther than this from home, the bot walks back before setting its crafting table or furnace down. */
const HOME_RANGE = 3;

/** Walks back near `home` when farther than {@link HOME_RANGE}; null when there (or back). */
async function goHome(context: GatherContext, home: Position, purpose: string, work: string): Promise<GatherResult | null> {
  const here = (await context.runtime.status()).position;
  if (Math.hypot(here.x - home.x, here.y - home.y, here.z - home.z) <= HOME_RANGE) return null;
  const target = { x: Math.floor(home.x), y: Math.floor(home.y), z: Math.floor(home.z), range: 1 };
  return act(context, "navigate", target, `Go back to the site to ${work} for ${purpose}.`);
}

/** Where crafting and smelting happen: `home` at first, the dry ground she moved to when no workstation fit there. */
export interface Site {
  home: Position;
}

/** Crafts with the carried table set down near the site's home, walking back there first when needed. */
export async function craftAtHome(context: GatherContext, items: readonly ItemCount[], purpose: string, site: Site, spent: Spent): Promise<GatherResult> {
  // A table close by is used where it stands, as a player would (owner, 2026-10-02: "check first if one is close").
  if ((await walkToStation(context, "crafting_table")) !== null) return craft(context, items, purpose, false, spent);
  const back = await goHome(context, site.home, purpose, "craft");
  if (back !== null) return back;
  // Back at the site, a table close to it counts too (live 2026-10-02: one 6 blocks from the site went unused
  // because she looked from where the logs were).
  if ((await walkToStation(context, "crafting_table")) !== null) return craft(context, items, purpose, false, spent);
  return withRoomForStation(context, site, () => craft(context, items, purpose, true, spent));
}

/**
 * A carried workstation needs a dry, clear cell with something solid under it within reach; in water, or in a crowded
 * tunnel, none is free (live 2026-10-02, and 2026-10-07 at the water's edge: "crafting_table: no_cell", and the boat
 * she needed was never crafted). A player steps onto dry ground first: she walks to the nearest land she has seen and
 * sets it down there, once; that ground is home for the rest of the gathering.
 */
async function withRoomForStation(context: GatherContext, site: Site, run: () => Promise<GatherResult>): Promise<GatherResult> {
  const first = await run();
  if (first.status !== "failed" || !/\[WORKSTATION_PLACEMENT_FAILED\] \S+: no_cell/u.test(first.detail)) return first;
  const here = (await context.runtime.status()).position;
  const land = await context.runtime.nearestLand(here).catch(() => null);
  if (land === null) return first;
  const why = "Step onto dry, open ground to set the workstation down.";
  const moved = await act(context, "navigate", { x: land.x, z: land.z, near_y: Math.floor(here.y), range: 4 }, why);
  if (moved !== null) return first;
  site.home = (await context.runtime.status()).position;
  return run();
}

/**
 * Smelts (at most one furnace load) in a furnace close by, else in the carried furnace set down near `home`, walking
 * back there first when needed.
 */
export async function smeltAtHome(context: GatherContext, job: SmeltJob, purpose: string, site: Site): Promise<GatherResult> {
  const count = Math.min(job.count, MAX_SMELT);
  const load = { item_name: job.input, count, fuel_item_name: job.fuel };
  const rationale = `Smelt ${count} ${job.input} into ${job.output} for ${purpose}.`;
  const done: GatherResult = { status: "done", detail: `smelted ${count} ${job.output} from ${job.input} with ${job.fuel}` };
  context.progress?.(`smelting ${count} ${job.input} into ${job.output} for ${purpose}`);
  const furnace = await walkToStation(context, "furnace");
  // A furnace still holding someone's items refuses the load: then her own, as if there were none.
  if (furnace !== null && (await act(context, "smelt_item", { ...load, ...furnace }, rationale)) === null) return done;
  if (context.signal.aborted) return { status: "stopped" };
  const back = await goHome(context, site.home, purpose, "smelt");
  if (back !== null) return back;
  const atHome = furnace === null ? await walkToStation(context, "furnace") : null;
  if (atHome !== null && (await act(context, "smelt_item", { ...load, ...atHome }, rationale)) === null) return done;
  if (context.signal.aborted) return { status: "stopped" };
  return withRoomForStation(context, site, async () => (await act(context, "smelt_item", { ...load, temporary_workstation: true }, rationale)) ?? done);
}

/** Within this many blocks, a placed crafting table or furnace is walked to and used instead of setting one down. */
const STATION_RANGE = 16;
/**
 * Without one of her own, a placed one is walked to from farther: making one costs materials, not just a few steps
 * (owner, 2026-10-07).
 */
export const STATION_RANGE_NONE_CARRIED = 48;

/**
 * Walks up to the nearest placed `block` when one is within {@link STATION_RANGE} (or
 * {@link STATION_RANGE_NONE_CARRIED} when she carries none); where it stands, or null when none is that close or the
 * way there fails (then a carried one is set down as before).
 */
export async function walkToStation(context: GatherContext, block: "crafting_table" | "furnace"): Promise<Position | null> {
  const { inventory } = await context.runtime.status();
  const range = inventory.some((stack) => stack.name === block) ? STATION_RANGE : STATION_RANGE_NONE_CARRIED;
  const found = await placedStation(context.runtime, block, range);
  if (found === undefined) return null;
  // Coordinates only: the result is spread into `navigate` and `smelt_item` inputs, which refuse unknown keys (live
  // 2026-10-03: the block's `name` made every walk to a crafting table fail validation).
  const station = { x: found.x, y: found.y, z: found.z };
  const outcome = await context.body.act("navigate", { ...station, range: 2 }, `Walk to the ${block.replaceAll("_", " ")} close by to use it.`, { signal: context.signal });
  return outcome.status === "succeeded" ? station : null;
}

/** The nearest placed `block` within `range` blocks of her; undefined when none is that close. */
export async function placedStation(runtime: BotRuntime, block: string, range: number): Promise<FoundBlock | undefined> {
  const here = (await runtime.status()).position;
  const found = (await runtime.findBlocks(block, 1))[0];
  return found !== undefined && Math.hypot(found.x - here.x, found.y - here.y, found.z - here.z) <= range ? found : undefined;
}

/** `withTable`: set the carried crafting table down for this batch and pick it up again. */
export async function craft(context: GatherContext, items: readonly ItemCount[], purpose: string, withTable: boolean, spent: Spent): Promise<GatherResult> {
  const input = { items: items.map(({ item, count }) => ({ item_name: item, count })), ...(withTable && { temporary_workstation: true }) };
  const before = (await context.runtime.status()).inventory;
  context.progress?.(`crafting ${describeMaterials(items)} for ${purpose}`);
  const step = await act(context, "craft_item", input, `Craft ${describeMaterials(items)} for ${purpose}.`);
  if (step?.status !== "stopped") spent(before, (await context.runtime.status()).inventory);
  return step ?? { status: "done", detail: `crafted ${describeMaterials(items)}` };
}
