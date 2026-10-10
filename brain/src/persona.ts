import { readFile } from "node:fs/promises";
import { z } from "zod";
import { SKILL_NAMES, type SkillName } from "./actions.ts";
import { ACTIVITIES, NEUTRAL_ACTIVITIES } from "./activities.ts";

/** How an agent relates to players by default (ADR-005: later a per-relation value, one global stance for now). */
export const STANCES = ["companion", "neutral", "rival"] as const;
export type Stance = (typeof STANCES)[number];

/** How a character feels about activities, strongest liking first (ADR-015). */
export const FEELINGS = ["loves", "likes", "dislikes", "hates"] as const;
export type Feeling = (typeof FEELINGS)[number];

/**
 * A specialisation is what a character prefers and avoids (ADR-015, refining ADR-005): one activity it loves, one it
 * likes, one it dislikes and one it hates, all different; every other activity is neutral. The fixed shape keeps every
 * character contrasted. They act only through the prompts, never as a switch: a character still does what it hates.
 */
export const preferencesSchema = z.strictObject({
  loves: z.enum(ACTIVITIES),
  likes: z.enum(ACTIVITIES),
  dislikes: z.enum(ACTIVITIES),
  hates: z.enum(ACTIVITIES),
}).refine((preferences) => new Set(FEELINGS.map((feeling) => preferences[feeling])).size === FEELINGS.length, "loves, likes, dislikes and hates name four different activities")
  .refine((preferences) => FEELINGS.every((feeling) => !NEUTRAL_ACTIVITIES.has(preferences[feeling])), "travelling is nobody's love or hate: name another activity");

export type Preferences = z.infer<typeof preferencesSchema>;

/** The LLM tiers of a mind (ADR-008). */
export const TIERS = ["chat", "action", "planner"] as const;
export type Tier = (typeof TIERS)[number];

const modelId = z.string().trim().min(1);

/** A feeling's pull in the activity draw: 0 (never) to 10. */
const feelingMultiplier = (fallback: number) => z.number().min(0).max(10).default(fallback);

/**
 * A character, as data (ADR-004). The Minecraft username must match the `--username` of the bot's host, because
 * that is the account the character speaks and acts through.
 */
export const personaSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/u, "kebab-case id"),
  username: z.string().regex(/^[A-Za-z0-9_]{3,16}$/u, "a valid Minecraft username"),
  displayName: z.string().trim().min(1).max(32),
  stance: z.enum(STANCES),
  description: z.string().trim().min(1).max(1_000),
  traits: z.array(z.string().trim().min(1).max(40)).max(8).default([]),
  voice: z.string().trim().min(1).max(400),
  /** What it prefers and avoids doing; none: it feels the same about everything. */
  preferences: preferencesSchema.optional(),
  style: z.string().trim().min(1).max(40).optional(),
  /** Players this character takes orders and questions from; empty = everyone (mindcraft's `only_chat_with`). */
  listensTo: z.array(z.string().min(1).max(16)).default([]),
  /**
   * Whose orders come first, most important first (ADR-011); `*` = any other player. "Server" is the console
   * operator. Told to the model, which decides; later derived from relationships (Phase 5).
   */
  authority: z.array(z.string().min(1).max(16)).min(1).default(["*"]),
  /** The character's own long-term goal, worked on when nobody gives it an order; none = it waits for orders. */
  goal: z.string().trim().min(1).max(600).optional(),
  /** Skills this character's body can use at all; default: the whole catalog. */
  skills: z.array(z.enum(SKILL_NAMES)).min(1).optional(),
  /** Preferences as settings, not code paths (ADR-011). */
  settings: z.strictObject({
    /** Model calls per minute for its own goal; orders and chat are never held back. */
    goalCallsPerMinute: z.number().int().min(1).max(120).default(6),
    /** Steps one objective may take before the character gives it up. */
    maxStepsPerObjective: z.number().int().min(1).max(500).default(40),
    /** The same step ending the same way this many times in a row means it is going nowhere: it gives the objective up. */
    maxSameStepInARow: z.number().int().min(2).max(50).default(3),
    /** Removed (owner, 2026-10-10: a step stops when it gains nothing, not on the clock); persona files that still carry it parse. */
    maxStepMinutes: z.number().optional(),
    /**
     * One skill failing this many times in a row, whatever its input, means it is going round in circles (live
     * 2026-10-07: explore failed in every direction in turn for 12 minutes): it gives the objective up.
     */
    maxSkillFailuresInARow: z.number().int().min(2).max(50).default(6),
    /** After a "stop", how long it rests before going back to its own goal. */
    restAfterStopSeconds: z.number().int().min(0).max(3_600).default(60),
    /** Working on an order, at most one line about what it does now every this many seconds (0: at each change). */
    narrateEverySeconds: z.number().int().min(0).max(3_600).default(30),
    /**
     * Lines from one player less than this many ms apart are read together as one message and get one answer (spec
     * 2026-10-09-chat-handling); 0 reads every line alone. Every reply waits at least this long after the last line.
     */
    chatBurstMs: z.number().int().min(0).max(10_000).default(1_500),
    /** Players never dig the block under their feet: routes then descend by staircase (runtime survival policy). */
    digStraightDown: z.boolean().default(false),
    /**
     * TEMPORARY (owner, 2026-10-07, until real night awareness): at night, unless on an order, it digs a roofed hole
     * and waits there for the day (brain/src/night-shelter.ts).
     */
    shelterAtNight: z.boolean().default(true),
    /**
     * How strongly each feeling pulls when it picks its own objective (spec 2026-10-09-activity-draw): the chance of an
     * activity is its feeling's multiplier over the sum of them all. A character may be more or less driven by its
     * tastes; never 0 by default, since it does a hated thing sometimes. Defaults are the owner's pick, 2026-10-09.
     */
    feelingMultipliers: z.strictObject({
      loves: feelingMultiplier(2),
      likes: feelingMultiplier(1.5),
      neutral: feelingMultiplier(1),
      dislikes: feelingMultiplier(0.6),
      hates: feelingMultiplier(0.3),
    }).prefault({}),
  }).prefault({}),
  /** Per-tier model ids for this character; missing tiers use the `MINE_AI_LLM_<TIER>_MODEL` defaults. */
  models: z.strictObject({ chat: modelId.optional(), action: modelId.optional(), planner: modelId.optional() }).default({}),
});

export type Persona = z.infer<typeof personaSchema>;

export async function loadPersona(path: string): Promise<Persona> {
  const parsed = personaSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
  if (!parsed.success) throw new Error(`[PERSONA_INVALID] ${path}: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

/** The skills a character may use: its own list or the whole catalog; one who may build may also improve its house. */
export function personaSkills(persona: Pick<Persona, "skills">): readonly SkillName[] {
  const skills = persona.skills ?? SKILL_NAMES;
  return skills.includes("build") && !skills.includes("improve_house") ? [...skills, "improve_house"] : skills;
}
