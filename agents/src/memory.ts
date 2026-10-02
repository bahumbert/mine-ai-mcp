import { z } from "zod";
import type { KnownPlace } from "./mind.ts";
import type { UnfinishedHouse } from "./skills.ts";

/**
 * What a character remembers across brain restarts: the places it made, how its own last objectives ended, and the
 * house it left unfinished. Each change is appended as a runtime note (`note_save`) in the world's bot data, so the
 * memory belongs to that world and bot, and the monitor shows it with the other notes. The note is a sentence for
 * people; the context carries the same memory as data, after a fixed prefix the brain reads back with one query.
 */
export type Memory =
  | { readonly kind: "place"; readonly place: KnownPlace }
  | { readonly kind: "own_objective"; readonly outcome: string }
  | { readonly kind: "unfinished_house"; readonly house: UnfinishedHouse | null };

export interface Recalled {
  /** Oldest first, one per name (the latest wins). */
  readonly places: readonly KnownPlace[];
  /** Oldest first. */
  readonly lately: readonly string[];
  readonly unfinished: UnfinishedHouse | null;
}

/** How many of each kind are read back; the agent keeps no more than this in its prompts anyway. */
export interface RecallLimits {
  readonly places: number;
  readonly lately: number;
}

const PREFIX = "brain memory";
const KINDS = ["place", "own_objective", "unfinished_house"] as const;

const position = z.object({ x: z.number(), y: z.number(), z: z.number() });
const memorySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("place"), place: z.object({ name: z.string().min(1), detail: z.string() }) }),
  z.object({ kind: z.literal("own_objective"), outcome: z.string().min(1) }),
  z.object({
    kind: z.literal("unfinished_house"),
    house: z.object({
      kind: z.string().min(1),
      site: z.object({ door: position, facing: z.enum(["north", "south", "east", "west"]) }),
      part: z.number().int().min(0),
      prepared: z.boolean().optional(),
    }).nullable(),
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
  return `${[latest("place", limits.places), latest("own_objective", limits.lately), latest("unfinished_house", 1)].join(" UNION ALL ")} ORDER BY note_id DESC`;
}

/** Rebuilds the memory from note contexts, newest first; anything that does not parse is skipped. */
export function recall(contexts: readonly string[], limits: RecallLimits): Recalled {
  const places = new Map<string, KnownPlace>();
  const lately: string[] = [];
  let unfinished: UnfinishedHouse | null | undefined;
  for (const context of contexts) {
    const memory = parse(context);
    if (memory === null) continue;
    if (memory.kind === "place" && !places.has(memory.place.name) && places.size < limits.places) places.set(memory.place.name, memory.place);
    if (memory.kind === "own_objective" && lately.length < limits.lately) lately.push(memory.outcome);
    if (memory.kind === "unfinished_house" && unfinished === undefined) unfinished = memory.house;
  }
  return { places: [...places.values()].reverse(), lately: lately.reverse(), unfinished: unfinished ?? null };
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
