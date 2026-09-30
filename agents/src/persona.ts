import { readFile } from "node:fs/promises";
import { z } from "zod";

/** How an agent relates to players by default (ADR-005: later a per-relation value, one global stance for now). */
export const STANCES = ["companion", "neutral", "rival"] as const;
export type Stance = (typeof STANCES)[number];

/** Specialisations are aptitudes (ADR-005): weights that bias choices, never switches that remove abilities. */
export const APTITUDES = ["builder", "farmer", "miner", "warrior", "explorer", "trader"] as const;

/** The LLM tiers of a mind (ADR-008). */
export const TIERS = ["chat", "action", "planner"] as const;
export type Tier = (typeof TIERS)[number];

const modelId = z.string().trim().min(1);

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
  aptitudes: z.partialRecord(z.enum(APTITUDES), z.number().min(0).max(1)).default({}),
  style: z.string().trim().min(1).max(40).optional(),
  /** Players this character takes orders and questions from; empty = everyone (mindcraft's `only_chat_with`). */
  listensTo: z.array(z.string().min(1).max(16)).default([]),
  /** Per-tier model ids for this character; missing tiers use the `MINE_AI_LLM_<TIER>_MODEL` defaults. */
  models: z.strictObject({ chat: modelId.optional(), action: modelId.optional(), planner: modelId.optional() }).default({}),
});

export type Persona = z.infer<typeof personaSchema>;

export async function loadPersona(path: string): Promise<Persona> {
  const parsed = personaSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
  if (!parsed.success) throw new Error(`[PERSONA_INVALID] ${path}: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}
