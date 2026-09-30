import { z } from "zod";
import type { Stance } from "./persona.ts";

const playerName = z.string().regex(/^[A-Za-z0-9_]{1,16}$/u, "a Minecraft username");
const minecraftId = z.string().regex(/^[a-z0-9_]+$/u, "a Minecraft id such as oak_log");
const coordinate = z.number().int().min(-30_000_000).max(30_000_000);

/** The runtime's `collect_block` limit (src/actions/collect-block/contract.ts `MAX_COLLECT_BLOCKS`). */
const MAX_COLLECT = 32;

/**
 * The basic functions the LLM tiers compose (ADR-008). Each step is validated here and run in code by
 * `skills.ts`, so whatever a player writes, the worst outcome is a sequence of these, gated again by stance.
 */
export const stepSchema = z.discriminatedUnion("skill", [
  z.strictObject({ skill: z.literal("follow_player"), player: playerName, distance: z.number().int().min(1).max(8).default(3) }),
  z.strictObject({ skill: z.literal("go_to_player"), player: playerName }),
  z.strictObject({ skill: z.literal("go_to"), x: coordinate, y: z.number().int().min(-64).max(320), z: coordinate }),
  z.strictObject({ skill: z.literal("collect_block"), block: minecraftId, count: z.number().int().min(1).max(MAX_COLLECT).default(1) }),
  z.strictObject({ skill: z.literal("give_item"), player: playerName, item: minecraftId, count: z.number().int().min(1).max(64).default(1) }),
  z.strictObject({ skill: z.literal("craft_item"), item: minecraftId, count: z.number().int().min(1).max(64).default(1) }),
  z.strictObject({ skill: z.literal("eat"), food: minecraftId }),
  z.strictObject({ skill: z.literal("equip"), item: minecraftId }),
  z.strictObject({ skill: z.literal("sleep") }),
  z.strictObject({ skill: z.literal("hunt"), mob: minecraftId, drop: minecraftId, count: z.number().int().min(1).max(16).default(1) }),
]);

export type Step = z.infer<typeof stepSchema>;
export type SkillName = Step["skill"];

/** One line per skill for the prompts: exact JSON shape, then what it does. */
export const SKILL_USAGE: Readonly<Record<SkillName, string>> = {
  follow_player: `{"skill":"follow_player","player":"<username>","distance":3}  keep following that player until told to stop; only as the last step`,
  go_to_player: `{"skill":"go_to_player","player":"<username>"}  walk up to that player once`,
  go_to: `{"skill":"go_to","x":0,"y":64,"z":0}  walk to block coordinates`,
  collect_block: `{"skill":"collect_block","block":"<block id>","count":<1-${MAX_COLLECT}>}  mine the nearest such blocks; name the block, not the drop (stone drops cobblestone; oak_log, dirt, coal_ore...)`,
  give_item: `{"skill":"give_item","player":"<username>","item":"<item id>","count":<1-64>}  walk to the player and hand over items you carry`,
  craft_item: `{"skill":"craft_item","item":"<item id>","count":<1-64>}  craft from your inventory; intermediate items (planks, sticks) are crafted automatically and a carried crafting_table is placed when needed; it never gathers missing materials`,
  eat: `{"skill":"eat","food":"<carried food id>"}  eat something you carry`,
  equip: `{"skill":"equip","item":"<carried item id>"}  hold or wear a carried item (armour goes to its slot)`,
  sleep: `{"skill":"sleep"}  sleep in a nearby bed (night or thunderstorm only)`,
  hunt: `{"skill":"hunt","mob":"<entity id>","drop":"<item id>","count":<1-16>}  kill nearby mobs of that type until you picked up that many drops (hostile mobs need a carried shield)`,
};

/**
 * What each stance agrees to do for players (Phase 1). Neutral and rival characters only talk for now: trading
 * (neutral) and opposition (rival) arrive with Phases 4 and 5. Enforced in code, not trusted to the model.
 */
const STANCE_SKILLS: Readonly<Record<Stance, readonly SkillName[]>> = {
  companion: Object.keys(SKILL_USAGE) as SkillName[],
  neutral: [],
  rival: [],
};

export function allowedSkills(stance: Stance): readonly SkillName[] {
  return STANCE_SKILLS[stance];
}

export function allowedStep(stance: Stance, step: Step): boolean {
  return STANCE_SKILLS[stance].includes(step.skill);
}

/** Steps a plan may contain; `follow_player` never ends, so it may only come last. */
export function planSchema(maxSteps: number) {
  return z
    .array(stepSchema)
    .min(1)
    .max(maxSteps)
    .refine((steps) => steps.every((step, index) => step.skill !== "follow_player" || index === steps.length - 1), {
      message: "follow_player never ends, so it can only be the last step",
    });
}

/** One line for logs and prompts, e.g. `collect 5 oak_log`. */
export function describeStep(step: Step): string {
  switch (step.skill) {
    case "follow_player": return `follow ${step.player} at ${step.distance} blocks`;
    case "go_to_player": return `go to ${step.player}`;
    case "go_to": return `go to ${step.x} ${step.y} ${step.z}`;
    case "collect_block": return `collect ${step.count} ${step.block}`;
    case "give_item": return `give ${step.count} ${step.item} to ${step.player}`;
    case "craft_item": return `craft ${step.count} ${step.item}`;
    case "eat": return `eat ${step.food}`;
    case "equip": return `equip ${step.item}`;
    case "sleep": return "sleep";
    case "hunt": return `hunt ${step.mob} for ${step.count} ${step.drop}`;
  }
}

export function describePlan(steps: readonly Step[]): string {
  return steps.map(describeStep).join(", then ");
}
