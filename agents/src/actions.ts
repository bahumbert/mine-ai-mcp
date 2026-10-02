import { z } from "zod";
import { describeMaterials } from "./building/blueprint.ts";
import { HOUSE_SIZES, type HouseSize } from "./building/house.ts";
import { chooseSite, planHouse } from "./building/plan.ts";
import type { Style } from "./building/styles.ts";

const playerName = z.string().regex(/^[A-Za-z0-9_]{1,16}$/u, "a Minecraft username");
const minecraftId = z.string().regex(/^[a-z0-9_]+$/u, "a Minecraft id such as oak_log");
const coordinate = z.number().int().min(-30_000_000).max(30_000_000);

/** The runtime's `collect_block` limit (src/actions/collect-block/contract.ts `MAX_COLLECT_BLOCKS`). */
const MAX_COLLECT = 32;
/** Kinds of items one `get_items` step fetches: a house needs six. */
const MAX_GET_ITEMS = 8;
/** The runtime's limit for a centre and radius (src/actions/protect-region/contract.ts `MAX_REGION_RADIUS`). */
const MAX_AREA_RADIUS = 31;

const SIZES = Object.keys(HOUSE_SIZES) as [HouseSize, ...HouseSize[]];

/**
 * The basic functions the models compose (ADR-008, ADR-011): one is chosen at a time, validated here and run in code
 * by `skills.ts`, so whatever anyone writes, the worst outcome is a sequence of these.
 */
export const stepSchema = z.discriminatedUnion("skill", [
  z.strictObject({ skill: z.literal("follow_player"), player: playerName, distance: z.number().int().min(1).max(8).default(3) }),
  z.strictObject({ skill: z.literal("go_to_player"), player: playerName }),
  z.strictObject({ skill: z.literal("go_to"), x: coordinate, y: z.number().int().min(-64).max(320), z: coordinate }),
  z.strictObject({ skill: z.literal("collect_block"), block: minecraftId, count: z.number().int().min(1).max(MAX_COLLECT).default(1) }),
  z.strictObject({ skill: z.literal("give_item"), player: playerName, item: minecraftId, count: z.number().int().min(1).max(64).default(1) }),
  z.strictObject({ skill: z.literal("craft_item"), item: minecraftId, count: z.number().int().min(1).max(64).default(1) }),
  z.strictObject({
    skill: z.literal("get_items"),
    items: z.array(z.strictObject({ item: minecraftId, count: z.number().int().min(1).max(256) })).min(1).max(MAX_GET_ITEMS),
  }),
  z.strictObject({ skill: z.literal("eat"), food: minecraftId }),
  z.strictObject({ skill: z.literal("equip"), item: minecraftId }),
  z.strictObject({ skill: z.literal("sleep") }),
  z.strictObject({ skill: z.literal("hunt"), mob: minecraftId, drop: minecraftId, count: z.number().int().min(1).max(16).default(1) }),
  z.strictObject({
    skill: z.literal("protect_area"),
    player: playerName.optional(),
    x: coordinate.optional(),
    y: z.number().int().min(-64).max(320).optional(),
    z: coordinate.optional(),
    radius: z.number().int().min(1).max(MAX_AREA_RADIUS).default(8),
    label: z.string().trim().min(1).max(80),
  }),
  z.strictObject({ skill: z.literal("release_area"), area: z.number().int().positive() }),
  z.strictObject({
    skill: z.literal("build"),
    structure: z.literal("house").default("house"),
    size: z.enum(SIZES).default("small"),
  }),
]);

export type Step = z.infer<typeof stepSchema>;
export type SkillName = Step["skill"];

export const SKILL_NAMES = [
  "follow_player", "go_to_player", "go_to", "collect_block", "give_item", "craft_item", "get_items", "eat", "equip", "sleep", "hunt", "protect_area", "release_area", "build",
] as const satisfies readonly SkillName[];

/**
 * One line per skill for the prompts: exact JSON shape, then what it does. The house line lists what the character's
 * own style needs, so the model can fetch it with `get_items` before building.
 */
export function skillUsage(skill: SkillName, style: Style): string {
  switch (skill) {
    case "follow_player": return `{"skill":"follow_player","player":"<username>","distance":3}  keep following that player; it never ends by itself, a new objective or "stop" ends it`;
    case "go_to_player": return `{"skill":"go_to_player","player":"<username>"}  walk up to that player once`;
    case "go_to": return `{"skill":"go_to","x":0,"y":64,"z":0}  walk to block coordinates`;
    case "collect_block": return `{"skill":"collect_block","block":"<block id>","count":<1-${MAX_COLLECT}>}  find, walk to and mine the nearest such blocks by itself (no need to look for them first); name the block, not the drop (stone drops cobblestone; oak_log, dirt, coal_ore...)`;
    case "give_item": return `{"skill":"give_item","player":"<username>","item":"<item id>","count":<1-64>}  walk to the player and hand over items you carry`;
    case "craft_item": return `{"skill":"craft_item","item":"<item id>","count":<1-64>}  craft from your inventory; intermediate items (planks, sticks) are crafted automatically and a carried crafting_table is placed when needed; it never gathers missing materials`;
    case "get_items": return `{"skill":"get_items","items":[{"item":"<item id>","count":<n>}]}  get <n> more of up to ${MAX_GET_ITEMS} kinds of items the way a player would: chop, dig (crafting a wooden pickaxe when stone is needed), craft with a carried crafting table and smelt in a carried furnace (glass, ingots from raw ore, charcoal, stone: it gathers the input and the fuel and crafts the furnace itself), keeping everything you already carry, then come back here; takes minutes`;
    case "eat": return `{"skill":"eat","food":"<carried food id>"}  eat something you carry`;
    case "equip": return `{"skill":"equip","item":"<carried item id>"}  hold or wear a carried item (armour goes to its slot)`;
    case "sleep": return `{"skill":"sleep"}  sleep in a nearby bed (night or thunderstorm only)`;
    case "hunt": return `{"skill":"hunt","mob":"<entity id>","drop":"<item id>","count":<1-16>}  kill nearby mobs of that type until you picked up that many drops (hostile mobs need a carried shield)`;
    case "protect_area": return `{"skill":"protect_area","player":"<username>","radius":8,"label":"<short name>"}  never dig or place blocks within radius (1-${MAX_AREA_RADIUS}) of where that player stands, or give "x","y","z" instead of "player"; e.g. around a build someone asked you to respect; you can still walk there`;
    case "release_area": return `{"skill":"release_area","area":<area number>}  stop protecting one of your protected areas, so you may dig and place blocks there again`;
    case "build": {
      const bills = SIZES.map((size) => `${size} = ${describeMaterials(planHouse(style, size, chooseSite({ x: 0, y: 64, z: 0 }, null)).bill)}`).join("; ");
      return `{"skill":"build","structure":"house","size":"<${SIZES.join("|")}>"}  build a house in your ${style.id} style where you stand, its door facing whoever asked; every block must be carried first (${bills})`;
    }
  }
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
    case "get_items": return `get ${describeMaterials(step.items)}`;
    case "eat": return `eat ${step.food}`;
    case "equip": return `equip ${step.item}`;
    case "sleep": return "sleep";
    case "hunt": return `hunt ${step.mob} for ${step.count} ${step.drop}`;
    case "protect_area": return `protect ${step.label} (${step.radius} blocks around ${step.player ?? `${step.x} ${step.y} ${step.z}`})`;
    case "release_area": return `release area #${step.area}`;
    case "build": return `build a ${step.size} ${step.structure}`;
  }
}
