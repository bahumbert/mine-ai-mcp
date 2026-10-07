import { setTimeout as sleep } from "node:timers/promises";
import type { Body } from "./body.ts";
import { areaKey, type BlockArea, type BotRuntime, type Position, type ProtectedArea } from "./runtime-client.ts";
import type { SkillResult } from "./skills.ts";

/**
 * TEMPORARY (owner, real-world session 2026-10-07: nights on his modded server are deadly; a quick measure until the
 * real night-awareness feature, backlog P1 "Night awareness"): at night she digs a hole three blocks deep where she
 * stands, roofs it with a carried block, waits there for the day, then digs the roof and climbs out. Code decides
 * this, not the model: a deliberate, temporary exception to Rule #0.
 */

/** Blocks dug under her feet: she ends with her head two blocks under the ground and the roof a block above it. */
const DEPTH = 3;
/** How far around her (blocks) a column fit for the hole is looked for. */
const SEARCH_RADIUS = 3;
/** How often she looks at the sky while waiting. */
const WAIT_SLICE_MS = 15_000;
/** Time for her to land after the block under her is dug. */
const FALL_MS = 700;

/** Blocks no bare hand or pickaxe she might carry digs in a reasonable time. */
const UNDIGGABLE = new Set(["bedrock", "obsidian", "crying_obsidian", "reinforced_deepslate", "barrier", "end_portal_frame", "respawn_anchor"]);
/** Roof blocks, the commonest first; then any planks or log. Never sand or gravel: they would fall on her head. */
const ROOF_BLOCKS = ["dirt", "cobblestone", "cobbled_deepslate", "netherrack", "stone", "deepslate", "andesite", "diorite", "granite", "tuff", "coarse_dirt", "rooted_dirt", "mud"];

type Face = "north" | "south" | "east" | "west";
/** A neighbour's offset and the face of it that looks back at the hole. */
const NEIGHBOURS: readonly (readonly [number, number, Face])[] = [[1, 0, "west"], [-1, 0, "east"], [0, 1, "north"], [0, -1, "south"]];

export interface ShelterSpot extends Position {
  /** The ground block beside the roof cell that the roof is placed against, and which face of it. */
  readonly support: Position;
  readonly face: Face;
}

/** The box `shelterSpot` needs read around `from`. */
export function shelterBox(from: Position): { readonly min: Position; readonly max: Position } {
  const x = Math.floor(from.x);
  const y = Math.floor(from.y);
  const z = Math.floor(from.z);
  return {
    min: { x: x - SEARCH_RADIUS - 1, y: y - 2 - DEPTH - 2, z: z - SEARCH_RADIUS - 1 },
    max: { x: x + SEARCH_RADIUS + 1, y: y + 2, z: z + SEARCH_RADIUS + 1 },
  };
}

/**
 * The nearest standing place (feet cell) within {@link SEARCH_RADIUS} of `from` where a hole {@link DEPTH} deep
 * stays closed: solid blocks to dig (no cave under), a solid floor, solid walls around the two cells she will be in,
 * a solid neighbour to roof against, and nothing in a protected area. Null when there is none.
 */
export function shelterSpot(area: BlockArea, from: Position, areas: readonly ProtectedArea[]): ShelterSpot | null {
  const name = (x: number, y: number, z: number) => area.blocks.get(areaKey(x, y, z));
  const solid = (x: number, y: number, z: number) => {
    const block = name(x, y, z);
    return block !== undefined && area.kinds[block]?.solid === true;
  };
  const open = (x: number, y: number, z: number) => {
    const block = name(x, y, z);
    return block !== undefined && !solid(x, y, z) && block !== "water" && block !== "lava";
  };
  const protectedCell = (x: number, y: number, z: number) =>
    areas.some(({ min, max }) => x >= min.x && x <= max.x && y >= min.y && y <= max.y && z >= min.z && z <= max.z);
  const fx = Math.floor(from.x);
  const fy = Math.floor(from.y);
  const fz = Math.floor(from.z);
  const columns: [number, number][] = [];
  for (let dx = -SEARCH_RADIUS; dx <= SEARCH_RADIUS; dx += 1) {
    for (let dz = -SEARCH_RADIUS; dz <= SEARCH_RADIUS; dz += 1) columns.push([fx + dx, fz + dz]);
  }
  columns.sort((a, b) => Math.hypot(a[0] - fx, a[1] - fz) - Math.hypot(b[0] - fx, b[1] - fz));
  for (const [x, z] of columns) {
    for (const feet of [fy, fy + 1, fy - 1, fy - 2]) {
      if (!open(x, feet, z) || !open(x, feet + 1, z) || !solid(x, feet - 1, z)) continue;
      const dug = Array.from({ length: DEPTH }, (_, index) => feet - 1 - index);
      if (!dug.every((y) => solid(x, y, z) && !UNDIGGABLE.has(name(x, y, z)!))) continue;
      if (!solid(x, feet - 1 - DEPTH, z)) continue;
      // Her feet and head end in the two lowest dug cells; the roof goes in the top one.
      const inside = dug.slice(1);
      if (!NEIGHBOURS.every(([ox, oz]) => inside.every((y) => solid(x + ox, y, z + oz)))) continue;
      if ([...dug, feet, feet + 1].some((y) => protectedCell(x, y, z))) continue;
      const roof = feet - 1;
      const support = NEIGHBOURS.find(([ox, oz]) => solid(x + ox, roof, z + oz));
      if (support === undefined) continue;
      return { x, y: feet, z, support: { x: x + support[0], y: roof, z: z + support[1] }, face: support[2] };
    }
  }
  return null;
}

/** How high above her head a solid block counts as cover (a roof, the rock over a mine). */
const COVER_HEIGHT = 24;

/**
 * Whether something solid is over her head (leaves do not count): underground or under a roof the night is no worse
 * than the day (live 2026-10-07: Ayla, at night in a mine shaft, found no ground to dig a hole in).
 */
export function coverOver(area: BlockArea, at: Position): boolean {
  const x = Math.floor(at.x);
  const z = Math.floor(at.z);
  const head = Math.floor(at.y) + 1;
  for (let y = head + 1; y <= head + COVER_HEIGHT; y += 1) {
    const block = area.blocks.get(areaKey(x, y, z));
    if (block !== undefined && !block.endsWith("_leaves") && area.kinds[block]?.solid === true) return true;
  }
  return false;
}

/** Reads the column over her head and tells {@link coverOver}. */
export async function underCover(runtime: BotRuntime, at: Position): Promise<boolean> {
  const x = Math.floor(at.x);
  const z = Math.floor(at.z);
  const head = Math.floor(at.y) + 1;
  return coverOver(await runtime.blocksIn({ x, y: head + 1, z }, { x, y: head + COVER_HEIGHT, z }), at);
}

/** The carried block she roofs the hole with, null when she carries none. */
export function roofBlock(inventory: readonly { readonly name: string }[]): string | null {
  for (const block of ROOF_BLOCKS) if (inventory.some((stack) => stack.name === block)) return block;
  return inventory.find((stack) => stack.name.endsWith("_planks") || stack.name.endsWith("_log"))?.name ?? null;
}

export interface ShelterContext {
  readonly runtime: BotRuntime;
  readonly body: Body;
  readonly signal: AbortSignal;
  readonly areas: readonly ProtectedArea[];
  /** True once the night is over (or there is no night where she is). */
  readonly dayCame: () => Promise<boolean>;
}

const WHY = "Night is dangerous: I dig in and wait for the day.";

/** Digs in, waits for the day, climbs out. `failed` when no hole could be made (she then goes on as before). */
export async function shelterForNight(context: ShelterContext): Promise<SkillResult> {
  const { runtime, body, signal } = context;
  const act = (tool: "navigate" | "raw_action", input: Record<string, unknown>) => body.act(tool, input, WHY, { signal });
  const start = (await runtime.status()).position;
  const box = shelterBox(start);
  const spot = shelterSpot(await runtime.blocksIn(box.min, box.max), start, context.areas);
  if (spot === null) return { status: "failed", detail: "no ground near here to dig a closed hole in (caves, water or protected areas)" };
  const here = (await runtime.status()).position;
  if (Math.floor(here.x) !== spot.x || Math.floor(here.z) !== spot.z || Math.floor(here.y) !== spot.y) {
    const moved = await act("navigate", { x: spot.x, y: spot.y, z: spot.z, range: 0 });
    if (signal.aborted) return { status: "stopped" };
    if (moved.status !== "succeeded") return { status: "failed", detail: `could not reach ${spot.x} ${spot.y} ${spot.z} to dig in: ${moved.error ?? moved.status}` };
  }
  for (let depth = 1; depth <= DEPTH; depth += 1) {
    const dug = await act("raw_action", { operation: "dig", x: spot.x, y: spot.y - depth, z: spot.z });
    if (signal.aborted) return { status: "stopped" };
    if (dug.status !== "succeeded") return { status: "failed", detail: `could not dig the hole at ${spot.x} ${spot.y - depth} ${spot.z}: ${dug.error ?? dug.status}` };
    await sleep(FALL_MS, undefined, { signal }).catch(() => undefined);
  }
  const block = roofBlock((await runtime.status()).inventory);
  let roofed = false;
  if (block !== null) {
    const { support, face } = spot;
    const placed = await act("raw_action", { operation: "place", block_name: block, x: support.x, y: support.y, z: support.z, face });
    roofed = placed.status === "succeeded";
  }
  const started = Date.now();
  while (!signal.aborted && !(await context.dayCame())) await sleep(WAIT_SLICE_MS, undefined, { signal }).catch(() => undefined);
  if (signal.aborted) return { status: "stopped" };
  const waited = Math.round((Date.now() - started) / 60_000);
  if (roofed) await act("raw_action", { operation: "dig", x: spot.x, y: spot.y - 1, z: spot.z });
  const out = await act("navigate", { x: spot.x, y: spot.y, z: spot.z, range: 1 });
  const how = roofed ? `in a hole roofed with ${block}` : "in an open hole (no block carried to roof it)";
  const climbed = out.status === "succeeded" ? "climbed out" : `still in the hole: ${out.error ?? out.status}`;
  return { status: "done", detail: `waited out the night ${how} at ${spot.x} ${spot.y - DEPTH} ${spot.z} for ${waited} min; ${climbed}` };
}
