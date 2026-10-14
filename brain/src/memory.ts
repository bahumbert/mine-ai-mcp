import { z } from "zod";
import { ACTIVITIES } from "./activities.ts";
import { BUILD_ROLES } from "./building/blueprint.ts";
import { HOUSE_SIZES, type HouseSize } from "./building/house.ts";
import type { KnownPlace } from "./mind.ts";
import type { ActivityTime } from "./time-spent.ts";
import type { UnfinishedHouse } from "./skills.ts";

/**
 * What a character remembers across brain restarts: the places it made, how its own last objectives ended, and the
 * house it left unfinished. Each change is appended as a runtime note (`note_save`) in the world's bot data, so the
 * memory belongs to that world and bot, and the monitor shows it with the other notes. The note is a sentence for
 * people; the context carries the same memory as data, after a fixed prefix the brain reads back with one query.
 */
/** A farm the character made, as it was when she last tended it. */
export interface KnownFarm {
  /** The item planted on it (wheat_seeds, carrot...). */
  readonly crop: string;
  readonly size: number;
  /** The middle cell at soil level, where the water is. */
  readonly centre: { readonly x: number; readonly y: number; readonly z: number };
  readonly madeAt: string;
  readonly tendedAt: string;
  /** Cells at the last tend: crops growing, ripe crops left, farmland left empty. */
  readonly state: { readonly planted: number; readonly ripe: number; readonly empty: number };
}

export type Memory =
  | { readonly kind: "place"; readonly place: KnownPlace }
  | { readonly kind: "own_objective"; readonly outcome: string }
  | { readonly kind: "unfinished_house"; readonly house: UnfinishedHouse | null }
  | { readonly kind: "farm"; readonly farm: KnownFarm }
  /** One finished step's activity and time (spec 2026-10-03-specialisations-preferences): the time per activity. */
  | { readonly kind: "activity_time"; readonly time: ActivityTime };

export interface Recalled {
  /** Oldest first, one per name (the latest wins). */
  readonly places: readonly KnownPlace[];
  /** Oldest first. */
  readonly lately: readonly string[];
  readonly unfinished: UnfinishedHouse | null;
  /** Oldest first, one per farm (by its centre; the latest note wins). */
  readonly farms: readonly KnownFarm[];
  /** Oldest first. */
  readonly times: readonly ActivityTime[];
}

/** How many of each kind are read back; the agent keeps no more than this in its prompts anyway. */
export interface RecallLimits {
  readonly places: number;
  readonly lately: number;
  readonly farms: number;
  /** Activity records read back: enough to cover the last hour. */
  readonly times: number;
}

const PREFIX = "brain memory";
const KINDS = ["place", "own_objective", "unfinished_house", "farm", "activity_time"] as const;

const position = z.object({ x: z.number(), y: z.number(), z: z.number() });
const facing = z.enum(["north", "south", "east", "west"]);
const materials = z.partialRecord(z.enum(BUILD_ROLES), z.string().min(1));
const houseSchema = z.object({ size: z.enum(Object.keys(HOUSE_SIZES) as [HouseSize, ...HouseSize[]]), style: z.string().min(1), door: position, facing, materials });
const memorySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("place"), place: z.object({ name: z.string().min(1), detail: z.string(), own: z.boolean().optional(), house: houseSchema.optional() }) }),
  z.object({ kind: z.literal("own_objective"), outcome: z.string().min(1) }),
  z.object({
    kind: z.literal("unfinished_house"),
    house: z.object({
      kind: z.string().min(1),
      site: z.object({ door: position, facing }),
      part: z.number().int().min(0),
      prepared: z.boolean().optional(),
      materials: materials.optional(),
    }).nullable(),
  }),
  z.object({
    kind: z.literal("farm"),
    farm: z.object({
      crop: z.string().min(1),
      size: z.number().int().positive(),
      centre: position,
      madeAt: z.string(),
      tendedAt: z.string(),
      state: z.object({ planted: z.number().int().min(0), ripe: z.number().int().min(0), empty: z.number().int().min(0) }),
    }),
  }),
  z.object({
    kind: z.literal("activity_time"),
    time: z.object({ activity: z.enum(ACTIVITIES), purpose: z.enum(ACTIVITIES).optional(), ended: z.string(), minutes: z.number().min(0) }),
  }),
]);

/** The note and context `note_save` stores for one memory. */
export function memoryNote(memory: Memory): { readonly note: string; readonly context: string } {
  return { note: describe(memory), context: `${PREFIX}: ${memory.kind} ${JSON.stringify(memory)}` };
}

function describe(memory: Memory): string {
  switch (memory.kind) {
    case "place": return `I know a place: ${memory.place.name} (${memory.place.detail}).`;
    case "own_objective": return `One of my own objectives ended: ${memory.outcome}`;
    case "unfinished_house": {
      const { house } = memory;
      return house === null
        ? "I have no unfinished house any more."
        : `I left a ${house.kind} unfinished at part ${house.part + 1}, door ${house.site.door.x} ${house.site.door.y} ${house.site.door.z} facing ${house.site.facing}.`;
    }
    case "farm": {
      const { farm } = memory;
      return `My ${farm.crop} farm, ${farm.size}x${farm.size} around ${farm.centre.x} ${farm.centre.y} ${farm.centre.z}: ${farm.state.planted} planted, ${farm.state.ripe} ripe, ${farm.state.empty} empty when I last tended it (${farm.tendedAt}).`;
    }
    case "activity_time": return `I spent ${memory.time.minutes.toFixed(1)} min ${memory.time.activity}${memory.time.purpose === undefined || memory.time.purpose === memory.time.activity ? "" : ` for ${memory.time.purpose}`} (until ${memory.time.ended}).`;
  }
}

/**
 * One `query_bot_data` statement returning the `context` of this bot's latest memories of each kind, newest first.
 * `username` is a validated Minecraft username (letters, digits, underscore), so it is safe inside the literal.
 */
export function recallQuery(username: string, limits: RecallLimits): string {
  const latest = (kind: (typeof KINDS)[number], limit: number) => {
    const prefix = `${PREFIX}: ${kind} `;
    return `SELECT * FROM (SELECT note_id, context FROM main.notes WHERE bot_id = '${username.replaceAll("'", "''")}' ` +
      `AND substr(context, 1, ${prefix.length}) = '${prefix}' ORDER BY note_id DESC LIMIT ${limit})`;
  };
  // A farm is noted at every tend: read enough notes to find the latest of each of the farms kept.
  return `${[latest("place", limits.places), latest("own_objective", limits.lately), latest("unfinished_house", 1), latest("farm", limits.farms * 8), latest("activity_time", limits.times)].join(" UNION ALL ")} ORDER BY note_id DESC`;
}

/** Rebuilds the memory from note contexts, newest first; anything that does not parse is skipped. */
export function recall(contexts: readonly string[], limits: RecallLimits): Recalled {
  const places = new Map<string, KnownPlace>();
  const lately: string[] = [];
  let unfinished: UnfinishedHouse | null | undefined;
  const farms = new Map<string, KnownFarm>();
  const times: ActivityTime[] = [];
  for (const context of contexts) {
    const memory = parse(context);
    if (memory === null) continue;
    if (memory.kind === "place" && !places.has(memory.place.name) && places.size < limits.places) places.set(memory.place.name, memory.place);
    if (memory.kind === "own_objective" && lately.length < limits.lately) lately.push(memory.outcome);
    if (memory.kind === "unfinished_house" && unfinished === undefined) unfinished = memory.house;
    if (memory.kind === "farm") {
      const key = `${memory.farm.centre.x},${memory.farm.centre.y},${memory.farm.centre.z}`;
      if (!farms.has(key) && farms.size < limits.farms) farms.set(key, memory.farm);
    }
    if (memory.kind === "activity_time" && times.length < limits.times) times.push(memory.time);
  }
  return { places: [...places.values()].reverse(), lately: lately.reverse(), unfinished: unfinished ?? null, farms: [...farms.values()].reverse(), times: times.reverse() };
}

function parse(context: string): Memory | null {
  if (!context.startsWith(`${PREFIX}: `)) return null;
  const json = context.slice(context.indexOf("{"));
  try {
    const parsed = memorySchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** This bot's activity-time notes, newest first, as `note_id` and `context` (for {@link staleActivityNotes}). */
export function activityNotesQuery(username: string): string {
  const prefix = `${PREFIX}: activity_time `;
  return `SELECT note_id, context FROM main.notes WHERE bot_id = '${username.replaceAll("'", "''")}' ` +
    `AND substr(context, 1, ${prefix.length}) = '${prefix}' ORDER BY note_id DESC`;
}

/**
 * The ids of activity-time notes older than the last `minutes` of play (spec 2026-10-04-activity-time-travel-
 * terraforming: the hour rotates), from rows of `note_id` and `context`, newest first. The note that crosses the hour
 * is kept.
 */
export function staleActivityNotes(rows: readonly (readonly unknown[])[], minutes: number): number[] {
  const stale: number[] = [];
  let played = 0;
  for (const [id, context] of rows) {
    const memory = parse(String(context ?? ""));
    if (memory?.kind !== "activity_time" || typeof id !== "number") continue;
    if (played >= minutes) stale.push(id);
    else played += memory.time.minutes;
  }
  return stale;
}
