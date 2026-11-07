// Collecting a block, and going to the nearest place she saw it when none is near; the words for a collect that found none.
import type { ActOutcome } from "../body.ts";
import { sameDimension } from "../bot-data-sql.ts";
import { carriesFamily } from "../inventory-room.ts";
import { errorCode, type BotRuntime, type Position, type SeenBlock } from "../runtime-client.ts";
import { boatToMake } from "./boat-wood.ts";
import { act, blocksBroken } from "./gather-action.ts";
import type { GatherContext, GatherResult } from "./gather-materials.ts";
import { RARE_DROP_BREAKS, type Knowledge } from "./how-to-get.ts";
import { FAR_TRIES } from "./limits.ts";

/** The runtime's `collect_block` limit per call (src/actions/collect-block/contract.ts `MAX_COLLECT_BLOCKS`). */
const MAX_COLLECT = 32;
/**
 * How far (horizontally) a fetch goes for what it gathers, from where each collect starts (spec 2026-10-03
 * fetch-range): never a trip by itself (live 2026-10-03: unbounded, a fetch for a scarce wood walked 900 blocks across
 * an ocean). Farther is a decision of the model: a `go_to` of its own.
 */
export const FETCH_RANGE = 64;

export async function collectAll(context: GatherContext, targets: readonly (readonly [string, number])[], purpose: string, knowledge: Knowledge): Promise<GatherResult> {
  const done: string[] = [];
  for (const [block, total] of targets) {
    context.progress?.(`gathering ${total} ${block} for ${purpose}`);
    const rare = knowledge.rare.get(block);
    for (let left = total; left > 0; left -= MAX_COLLECT) {
      // A rare drop is asked for only as many blocks as its bound still allows.
      const count = Math.max(1, Math.min(left, MAX_COLLECT, rare === undefined ? MAX_COLLECT : RARE_DROP_BREAKS - rare.broken));
      let broken = 0;
      const countBroken = (outcome: ActOutcome) => { broken += blocksBroken(outcome.result); };
      // A rare drop is also told the breaks it has left, so one call cannot spend the budget of its chance (hundreds of leaves).
      const breaksLeft = (): number | null => rare === undefined ? null : Math.max(1, RARE_DROP_BREAKS - rare.broken - broken);
      let step = await act(context, "collect_block", { block_name: block, count, max_distance: FETCH_RANGE, ...(breaksLeft() !== null && { max_breaks: breaksLeft() }) }, `Gather ${count} ${block} for ${purpose}.`, knowledge, countBroken);
      if (step?.status === "failed" && noneUsableNear(step.detail)) step = await fetchFarther(context, block, count, purpose, step, countBroken, breaksLeft);
      // The blocks broken, as the runtime counts them, not the drops that came (a rare drop comes from few of them).
      if (rare !== undefined) rare.broken += broken;
      if (step !== null) return step.status === "failed" ? { status: "failed", detail: await notNear(context, block, step.detail) } : step;
    }
    done.push(`collected ${total} ${block}`);
  }
  return { status: "done", detail: done.join(", ") };
}

/** The nearest places looked at, at most, in one gathering. */
const FAR_CANDIDATES = 256;
/**
 * Places that held nothing she may take, by bot (chunk middles, "x,z"), for this run: not tried again. The runtime
 * rescans a chunk loaded again after 10 minutes, so its record catches up with the world anyway.
 */
const triedPlaces = new WeakMap<BotRuntime, Set<string>>();

/** Nothing within range, or nothing there she can take (inside protected areas, under water, blocked). */
function noneUsableNear(detail: string): boolean {
  const code = errorCode(detail);
  return code === "NO_TARGET_IN_RANGE" || code === "NO_LOADED_MATCHING_TARGETS" ||
    (code === "NO_REACHABLE_MATCHING_TARGETS" && !/no carried tool/u.test(detail));
}

/**
 * The places beyond the near search where she saw `block` (the bot data's record of what each explored chunk holds),
 * nearest first, at any distance, never one she found empty already nor one holding a protected area: gathering is
 * mining, and the blocks of a protected area are its walls (owner, 2026-10-07: "skip entirely protected things"; live
 * 2026-10-04: the nearest oak logs Ayla had seen were her own houses'). The near search still takes the free blocks
 * around them.
 */
export async function knownPlaces(runtime: BotRuntime, block: string, from: Position): Promise<readonly SeenBlock[]> {
  const tried = triedSet(runtime);
  const areas = await runtime.protectedRegions().catch(() => []);
  const guarded = (x: number, z: number) => areas.some((area) => area.min.x <= x + 8 && area.max.x >= x - 8 && area.min.z <= z + 8 && area.max.z >= z - 8);
  // Read once (live 2026-10-04: one query per place, through thousands of chunks, held Ayla still for minutes).
  return (await runtime.seenPlaces(block, from, FETCH_RANGE, FAR_CANDIDATES).catch(() => []))
    .filter((place) => !tried.has(`${place.x},${place.z}`) && !guarded(place.x, place.z));
}

function triedSet(runtime: BotRuntime): Set<string> {
  const tried = triedPlaces.get(runtime) ?? new Set<string>();
  triedPlaces.set(runtime, tried);
  return tried;
}

/**
 * A near search that found none has looked at every place within its range: the record's places there are stale
 * (cut since, or never what the record says) and are not offered again this run (live 2026-10-07: spruce "seen" 6
 * blocks from Ayla, none loaded; `explore` kept sending her back to it, `get_items` found none, for 15 minutes).
 */
async function forgetEmptyNear(runtime: BotRuntime, block: string, here: Position): Promise<void> {
  const tried = triedSet(runtime);
  for (const place of await runtime.seenPlaces(block, here, 0, FAR_CANDIDATES).catch(() => [])) {
    if (Math.hypot(place.x - here.x, place.z - here.z) > FETCH_RANGE) break;
    tried.add(`${place.x},${place.z}`);
  }
}

/**
 * None of `block` near that she may take: the nearest places she knows of ({@link knownPlaces}), at any distance, walked
 * to and collected there (owner, 2026-10-07: "return the closest known resource and that's it"; a way over deep water
 * needs a boat, and `navigate` says so). Null when collected, else what went wrong; with no place known, she is told to
 * explore.
 */
async function fetchFarther(context: GatherContext, block: string, count: number, purpose: string, failed: GatherResult, observe?: (outcome: ActOutcome) => void, breaksLeft: () => number | null = () => null): Promise<GatherResult | null> {
  const tried = triedSet(context.runtime);
  const start = (await context.runtime.status()).position;
  const code = failed.status === "failed" ? errorCode(failed.detail) : null;
  // Trees near that none could be reached are as good as none (live 2026-10-10: the same unreachable trees, round after round).
  if (code === "NO_TARGET_IN_RANGE" || code === "NO_LOADED_MATCHING_TARGETS" || code === "NO_REACHABLE_MATCHING_TARGETS") await forgetEmptyNear(context.runtime, block, start);
  const places = await knownPlaces(context.runtime, block, start);
  if (places.length === 0) {
    const why = failed.status === "failed" ? ` (${failed.detail})` : "";
    return { status: "failed", detail: `no ${block} within ${FETCH_RANGE} blocks that you may take, and you know of none farther away outside protected areas: explore for it (toward land you have not seen), use another material, or say so${why}` };
  }
  let last = failed;
  let acrossWater = 0;
  const boat = carriesFamily((await context.runtime.status()).inventory, "boat");
  let tries = 0;
  for (const seen of places) {
    if (context.signal.aborted || tries >= FAR_TRIES) break;
    const here = (await context.runtime.status()).position;
    // Across deep water with no boat the walk fails: not tried, and not marked either (a boat may come).
    if (!boat) {
      const water = await context.runtime.waterAlong(here, { x: seen.x, y: here.y, z: seen.z }).catch(() => null);
      if (water !== null && water.share > 0.5) {
        acrossWater += 1;
        continue;
      }
    }
    tries += 1;
    context.progress?.(`going ${describeWay(here, seen)} to the ${block} seen there, for ${purpose}`);
    const why = `Go to the ${block} I saw ${describeWay(here, seen)}, for ${purpose}.`;
    // Caves under the ground, trees over it: the walk is to the ground nearest her own height (as `explore` does).
    context.heading?.({ x: seen.x, z: seen.z });
    const there = await act(context, "navigate", { x: seen.x, z: seen.z, near_y: Math.floor(here.y), range: 12 }, why);
    context.heading?.(null);
    if (there !== null) {
      // A place that could not be reached is not offered again by the next round.
      tried.add(`${seen.x},${seen.z}`);
      last = there;
      // The same water lies between her and the next far place: not walked to (live 2026-10-10 run 10: ~1500 blocks swum).
      if (there.status === "failed" && errorCode(there.detail) === "NAVIGATION_DEEP_WATER") return { status: "failed", detail: await acrossWaterHint(context.runtime, block, failed) };
      continue;
    }
    const step = await act(context, "collect_block", { block_name: block, count, max_distance: FETCH_RANGE, ...(breaksLeft() !== null && { max_breaks: breaksLeft() }) }, `Gather ${count} ${block} for ${purpose}.`, undefined, observe);
    if (step === null) return null;
    last = step;
    if (step.status !== "failed" || !noneUsableNear(step.detail)) return step;
    tried.add(`${seen.x},${seen.z}`);
  }
  if (tries === 0 && acrossWater > 0) return { status: "failed", detail: await acrossWaterHint(context.runtime, block, failed) };
  return last;
}

/** What a fetch tells when the places it knows lie across deep water and no boat is carried. */
async function acrossWaterHint(runtime: BotRuntime, block: string, failed: GatherResult): Promise<string> {
  return `the ${block} you know of is across the water: take a boat (get_items ${await boatToMake(runtime)}) and go_to there, use another material, or say so (${failed.status === "failed" ? failed.detail : "none near"})`;
}

/** The eight compass directions, by the angle from east going south (Minecraft's +z is south). */
const COMPASS = ["east", "south-east", "south", "south-west", "west", "north-west", "north", "north-east"] as const;

/**
 * A collect that found nothing in range, told with what the bot knows: where it saw that block before beyond that range
 * (the bot data's explored chunks), how far and which way, or that it knows of none; the model decides what to do (go there, use another
 * material, tell whoever asked). Other failures are passed on as they are.
 */
export async function notNear(context: Pick<GatherContext, "runtime">, block: string, detail: string): Promise<string> {
  const code = errorCode(detail);
  if (code !== "NO_TARGET_IN_RANGE" && code !== "NO_LOADED_MATCHING_TARGETS") return detail;
  const { position: here, dimension } = await context.runtime.status();
  await forgetEmptyNear(context.runtime, block, here);
  // A place she may still take from in this world, else one seen in another dimension.
  const elsewhere = await context.runtime.seenAt(block, here, FETCH_RANGE).catch(() => null);
  const seen = (await knownPlaces(context.runtime, block, here))[0] ?? (elsewhere !== null && sameDimension(elsewhere.dimension, dimension) ? null : elsewhere);
  const near = `no ${block} within ${FETCH_RANGE} blocks`;
  if (seen === null) return `${near}, and you know of none farther away: explore for it (toward land you have not seen), use another material, or say so (${detail})`;
  if (!sameDimension(seen.dimension, dimension)) return `${near}; you saw some in ${seen.dimension.replaceAll("_", " ")} around ${seen.x} ${seen.z} (${detail})`;
  // Across water she knows (the explored chunks on the straight way are mostly water): a trip by boat (spec 2026-10-04).
  const water = await context.runtime.waterAlong(here, { x: seen.x, y: here.y, z: seen.z }).catch(() => null);
  if (water !== null && water.share > 0.5) {
    const boat = carriesFamily((await context.runtime.status()).inventory, "boat");
    const trip = boat ? "go_to there crosses by boat (you carry one)" : `take a boat (get_items ${await boatToMake(context.runtime)}) and go_to there`;
    return `${near}; you saw some ${describeWay(here, seen)}, across the water, around ${seen.x} ${Math.floor(here.y)} ${seen.z}: ${trip} if it is worth the trip, use another material, or say so (${detail})`;
  }
  return `${near}; you saw some ${describeWay(here, seen)}, around ${seen.x} ${Math.floor(here.y)} ${seen.z}: go_to there yourself if it is worth the trip, use another material, or say so (${detail})`;
}

/** "18 blocks south-west": how far `to` is from `from` across the ground, and which way. */
export function describeWay(from: { readonly x: number; readonly z: number }, to: { readonly x: number; readonly z: number }): string {
  const [dx, dz] = [to.x - from.x, to.z - from.z];
  return `${Math.round(Math.hypot(dx, dz))} blocks ${COMPASS[(Math.round(Math.atan2(dz, dx) / (Math.PI / 4)) + 8) % 8]}`;
}
