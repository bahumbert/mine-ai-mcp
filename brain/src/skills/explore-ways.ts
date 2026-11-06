// What explore knows about the ways around her: unseen land each way, seas already sailed, whether she is on water.
import { COMPASS_HEADINGS } from "../actions.ts";
import { areaKey, type BotRuntime, type Position } from "../runtime-client.ts";
import type { SkillContext } from "../skills.ts";

/** How far ahead unseen land is looked for, along each way. */
export const EXPLORE_REACH = 512;

/** How near where a way was sailed without land it counts as the same way. */
export const OPEN_SEA_NEAR = 256;

/**
 * Whether she stands in or on water: a mostly-water chunk is not enough (live 2026-10-07: Ayla, on a hill by the sea,
 * was told she was "out on the water").
 */
export async function onWater(runtime: BotRuntime, at: Position): Promise<boolean> {
  const x = Math.floor(at.x);
  const y = Math.floor(at.y);
  const z = Math.floor(at.z);
  const area = await runtime.blocksIn({ x, y: y - 1, z }, { x, y, z }).catch(() => null);
  if (area === null) return true;
  const names = [y, y - 1].map((level) => area.blocks.get(areaKey(x, level, z)));
  return names.every((name) => name === undefined) || names.includes("water");
}
/** A way sailed without finding land: where the ride started, where it ended (at sea), and how far no land was found. */
interface OpenSeaWay {
  readonly toward: string;
  readonly from: { readonly x: number; readonly z: number };
  readonly to: { readonly x: number; readonly z: number };
  readonly blocks: number;
}

/** Ways sailed without finding land, by bot, this run. */
const openSeas = new WeakMap<object, OpenSeaWay[]>();

export function openSeaWays(runtime: object): OpenSeaWay[] {
  const ways = openSeas.get(runtime) ?? [];
  openSeas.set(runtime, ways);
  return ways;
}

/** "north 180 blocks, east 40 blocks; seen as far as 512 blocks: south, west": how far unseen land is each way. */
export async function unseenWays(context: SkillContext, from: Position): Promise<string> {
  const { near, none } = await unseenWayList(context, from);
  return [near.join(", "), none.length === 0 ? "" : `seen as far as ${EXPLORE_REACH} blocks: ${none.join(", ")}`].filter((part) => part !== "").join("; ");
}

/** The ways with unseen land within reach ("north 180 blocks"), nearest first, and those seen all the way. */
export async function unseenWayList(context: SkillContext, from: Position): Promise<{ readonly near: readonly string[]; readonly none: readonly string[] }> {
  const near: string[] = [];
  const none: string[] = [];
  const ways = await Promise.all(Object.entries(COMPASS_HEADINGS).map(async ([way, degrees]) => {
    const radians = (degrees * Math.PI) / 180;
    const to = { x: from.x + Math.sin(radians) * EXPLORE_REACH, y: from.y, z: from.z - Math.cos(radians) * EXPLORE_REACH };
    return [way, await context.runtime.unseenAlong(from, to).catch(() => null)] as const;
  }));
  for (const [way, distance] of [...ways].sort((a, b) => (a[1] ?? Infinity) - (b[1] ?? Infinity))) {
    if (distance === null) none.push(way);
    else near.push(`${way} ${distance} blocks`);
  }
  return { near, none };
}
