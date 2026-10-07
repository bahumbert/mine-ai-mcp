import { z } from "zod";
import { describeMaterials } from "./building/blueprint.ts";
import { HOUSE_SIZES, type HouseSize } from "./building/house.ts";
import { chooseSite, planHouse } from "./building/plan.ts";
import type { Style } from "./building/styles.ts";
import { FARM_SIZES } from "./farming/plot.ts";

const playerName = z.string().regex(/^[A-Za-z0-9_]{1,16}$/u, "a Minecraft username");
const minecraftId = z.string().regex(/^[a-z0-9_]+$/u, "a Minecraft id such as oak_log");
const coordinate = z.number().int().min(-30_000_000).max(30_000_000);

/** The runtime's `collect_block` limit (src/actions/collect-block/contract.ts `MAX_COLLECT_BLOCKS`). */
const MAX_COLLECT = 32;
/** Kinds of items one `get_items` step fetches: a house needs six. */
const MAX_GET_ITEMS = 8;
/** Kinds of items one `drop_item` step drops (src/actions/drop-item/contract.ts). */
const MAX_DROP_ITEMS = 12;
/** Farming this close to the middle of a farm she knows tends that farm instead of starting a new one. */
export const FARM_RANGE = 8;
/** The runtime's limit for a centre and radius (src/actions/protect-region/contract.ts `MAX_REGION_RADIUS`). */
const MAX_AREA_RADIUS = 31;

const SIZES = Object.keys(HOUSE_SIZES) as [HouseSize, ...HouseSize[]];

/** The eight compass words the models use (and results say), as headings in degrees clockwise from north. */
export const COMPASS_HEADINGS = {
  north: 0, "north-east": 45, east: 90, "south-east": 135, south: 180, "south-west": 225, west: 270, "north-west": 315,
} as const;
const COMPASS_WORDS = Object.keys(COMPASS_HEADINGS) as [keyof typeof COMPASS_HEADINGS, ...(keyof typeof COMPASS_HEADINGS)[]];
/** The runtime's `explore_frontier` limit (src/actions/explore-frontier/contract.ts `MAX_EXPLORE_CHUNKS`). */
const MAX_EXPLORE_CHUNKS = 8;

/**
 * The basic functions the models compose (ADR-008, ADR-011): one is chosen at a time, validated here and run in code
 * by `skills.ts`, so whatever anyone writes, the worst outcome is a sequence of these.
 */
export const stepSchema = z.discriminatedUnion("skill", [
  z.strictObject({ skill: z.literal("follow_player"), player: playerName, distance: z.number().int().min(1).max(8).default(3), minutes: z.number().int().min(1).max(15).optional() }),
  z.strictObject({ skill: z.literal("go_to_player"), player: playerName }),
  z.strictObject({ skill: z.literal("go_to"), x: coordinate, y: z.number().int().min(-64).max(320), z: coordinate }),
  z.strictObject({
    skill: z.literal("explore"),
    toward: z.enum(COMPASS_WORDS),
    chunks: z.number().int().min(1).max(MAX_EXPLORE_CHUNKS).default(4),
    for: minecraftId.optional(),
  }),
  z.strictObject({ skill: z.literal("collect_block"), block: minecraftId, count: z.number().int().min(1).max(MAX_COLLECT).default(1) }),
  z.strictObject({ skill: z.literal("give_item"), player: playerName, item: minecraftId, count: z.number().int().min(1).max(64).default(1) }),
  // Several at once (live 2026-10-04: a full inventory took 20 steps of dropping one item each); one item still reads.
  z.strictObject({
    skill: z.literal("drop_item"),
    items: z.array(z.strictObject({ item: minecraftId, count: z.number().int().min(1).max(2304).optional() })).min(1).max(MAX_DROP_ITEMS).optional(),
    item: minecraftId.optional(),
    count: z.number().int().min(1).max(2304).optional(),
  }).refine((step) => (step.items === undefined) !== (step.item === undefined), { message: "drop_item takes items: [{item, count}, ...]" }),
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
    skill: z.literal("level_area"),
    x1: coordinate.optional(),
    z1: coordinate.optional(),
    x2: coordinate.optional(),
    z2: coordinate.optional(),
    around: playerName.optional(),
    radius: z.number().int().min(2).max(16).default(5),
    markers: minecraftId.optional(),
    y: z.number().int().min(-64).max(320).optional(),
    fill: minecraftId.optional(),
  }),
  z.strictObject({
    skill: z.literal("farm"),
    crop: minecraftId.optional(),
    size: z.literal(FARM_SIZES).default(9),
    x: coordinate.optional(),
    y: z.number().int().min(-64).max(320).optional(),
    z: coordinate.optional(),
  }).refine((step) => [step.x, step.y, step.z].every((axis) => axis === undefined) || [step.x, step.y, step.z].every((axis) => axis !== undefined), "give x, y and z together, or none"),
  z.strictObject({
    skill: z.literal("build"),
    structure: z.literal("house").default("house"),
    size: z.enum(SIZES).default("small"),
    x: coordinate.optional(),
    y: z.number().int().min(-64).max(320).optional(),
    z: coordinate.optional(),
  }),
]);

export type Step = z.infer<typeof stepSchema>;
export type SkillName = Step["skill"];

/** What a `drop_item` step drops, whichever form it was written in. */
export function dropEntries(step: Extract<Step, { skill: "drop_item" }>): readonly { readonly item: string; readonly count?: number | undefined }[] {
  return step.items ?? (step.item === undefined ? [] : [{ item: step.item, count: step.count }]);
}

export const SKILL_NAMES = [
  "follow_player", "go_to_player", "go_to", "explore", "collect_block", "give_item", "drop_item", "craft_item", "get_items", "eat", "equip", "sleep", "hunt", "protect_area", "release_area", "level_area", "build", "farm",
] as const satisfies readonly SkillName[];

/**
 * One line per skill for the prompts: exact JSON shape, then what it does. The house line lists what the character's
 * own style needs, so the model can fetch it with `get_items` before building.
 */
export function skillUsage(skill: SkillName, style: Style): string {
  switch (skill) {
    case "follow_player": return `{"skill":"follow_player","player":"<username>","distance":3,"minutes":5}  follow that player: asked by them, leave "minutes" out and it lasts until they stop talking to you for 10 minutes (or say stop); on your own, "minutes" (1-15) says how long`;
    case "go_to_player": return `{"skill":"go_to_player","player":"<username>"}  walk up to that player once`;
    case "go_to": return `{"skill":"go_to","x":0,"y":64,"z":0}  walk to block coordinates`;
    case "explore": return `{"skill":"explore","toward":"<${COMPASS_WORDS.join("|")}>","chunks":<1-${MAX_EXPLORE_CHUNKS}>,"for":"<block id>"}  walk that way past the edge of the land you know (a chunk is 16 blocks; 4 chunks take about a minute), to find what you know of nowhere ("for": it stops once one is within reach and says where; for a block you already know of, get_items goes there by itself); it does not set off toward water you have seen there; you stay where it ends, so fetch or build there, or go back`;
    case "collect_block": return `{"skill":"collect_block","block":"<block id>","count":<1-${MAX_COLLECT}>}  find, walk to and mine the nearest such blocks within 64 blocks by itself (no need to look for them first; farther, it says where you last saw some); name the block, not the drop (stone drops cobblestone; oak_log, dirt, coal_ore...)`;
    case "give_item": return `{"skill":"give_item","player":"<username>","item":"<item id>","count":<1-64>}  walk to the player and hand over items you carry`;
    case "drop_item": return `{"skill":"drop_item","items":[{"item":"<item id>","count":<n>}, ...]}  drop items you carry on the ground where you stand, up to ${MAX_DROP_ITEMS} kinds in one step (no "count": all of that item), e.g. to make room: crafting and gathering stop when all 36 inventory slots are taken, and a slot is freed only when a whole stack goes, so drop all of everything you do not need at once; what you drop is lost`;
    case "craft_item": return `{"skill":"craft_item","item":"<item id>","count":<1-64>}  craft from your inventory; intermediate items (planks, sticks) are crafted automatically and a carried crafting_table is placed when needed; it never gathers missing materials`;
    case "get_items": return `{"skill":"get_items","items":[{"item":"<item id>","count":<n>}]}  get <n> more of up to ${MAX_GET_ITEMS} kinds of items the way a player would: chop, dig (crafting a wooden pickaxe when stone is needed), craft with a carried crafting table and smelt in a carried furnace (glass, ingots from raw ore, charcoal, stone: it gathers the input and the fuel and crafts the furnace itself), keeping everything you already carry, then come back here; it fetches within 64 blocks only: when something is not near, it says where you last saw some (or that you never did), and going there is a go_to step of its own, worth it or not; takes minutes`;
    case "eat": return `{"skill":"eat","food":"<carried food id>"}  eat something you carry`;
    case "equip": return `{"skill":"equip","item":"<carried item id>"}  hold or wear a carried item (armour goes to its slot)`;
    case "sleep": return `{"skill":"sleep"}  sleep in a nearby bed (night or thunderstorm only)`;
    case "hunt": return `{"skill":"hunt","mob":"<entity id>","drop":"<item id>","count":<1-16>}  kill nearby mobs of that type until you picked up that many drops (hostile mobs need a carried shield)`;
    case "level_area": return `{"skill":"level_area","markers":"<block id>"}  flatten (level, terraform) the zone between the nearest 2-4 blocks of that kind a player placed as markers: it finds the markers itself (do not look for them first) and keeps them, digs everything above their level and fills holes below, with the right tool for each block; add "y":<walking level> for another height. Or {"skill":"level_area","around":"<username>","radius":<2-16>} for a square around a player at their level, or "x1","z1","x2","z2" corners with "y" (they keep no block: when a player placed markers, use "markers" so they stay, even after walking up to them); at most 32 by 32; holes, water and drops get a one-block floor of dirt (or cobblestone), or of the block in "fill":"<block id>" when one is asked for; takes minutes`;
    case "protect_area": return `{"skill":"protect_area","player":"<username>","radius":8,"label":"<short name>"}  never dig or place blocks within radius (1-${MAX_AREA_RADIUS}) of where that player stands, or give "x","y","z" instead of "player"; e.g. around a build someone asked you to respect; you can still walk there`;
    case "release_area": return `{"skill":"release_area","area":<area number>}  stop protecting one of your protected areas, so you may dig and place blocks there again: whatever it protects can then be dug up (leveling over your own house digs the house); an area owned by another player is theirs, released only when they say so`;
    case "farm": return `{"skill":"farm","crop":"<item to plant>","size":<3|5|7|9>}  make a crop farm like a player: a size x size plot right behind you (away from whoever asked; or add "x","y","z" for its middle, y at walking level), leveled, water poured in its middle, tilled and planted with the crop item (wheat_seeds, carrot, potato, beetroot_seeds); needs a hoe, some of the crop item and a bucket (or a water bucket) carried; farming one of your farms again (within ${FARM_RANGE} blocks of its middle) harvests what is ripe and replants it; crops take a while to ripen near the water`;
    case "build": {
      const bills = SIZES.map((size) => `${size} = ${describeMaterials(planHouse(style, size, chooseSite({ x: 0, y: 64, z: 0 }, null)).bill)}`).join("; ");
      return `{"skill":"build","structure":"house","size":"<${SIZES.join("|")}>"}  build a house in your ${style.id} style where you stand, its door facing whoever asked; add "x","y","z" (the door, at walking level) to build it at a given place: it walks there itself; it levels its own site first (trees, slopes, holes); every block must be carried first (${bills})`;
    }
  }
}

/** One line for logs and prompts, e.g. `collect 5 oak_log`. */
export function describeStep(step: Step): string {
  switch (step.skill) {
    case "follow_player": return `follow ${step.player} at ${step.distance} blocks`;
    case "go_to_player": return `go to ${step.player}`;
    case "go_to": return `go to ${step.x} ${step.y} ${step.z}`;
    case "explore": return `explore ${step.chunks} chunks ${step.toward}${step.for === undefined ? "" : ` for ${step.for}`}`;
    case "collect_block": return `collect ${step.count} ${step.block}`;
    case "give_item": return `give ${step.count} ${step.item} to ${step.player}`;
    case "drop_item": return `drop ${dropEntries(step).map((entry) => `${entry.count ?? "all"} ${entry.item}`).join(", ")}`;
    case "craft_item": return `craft ${step.count} ${step.item}`;
    case "get_items": return `get ${describeMaterials(step.items)}`;
    case "eat": return `eat ${step.food}`;
    case "equip": return `equip ${step.item}`;
    case "sleep": return "sleep";
    case "hunt": return `hunt ${step.mob} for ${step.count} ${step.drop}`;
    case "level_area": return `level ${step.markers !== undefined ? `the zone between the ${step.markers} markers` : step.around !== undefined ? `${step.radius} blocks around ${step.around}` : `${step.x1} ${step.z1} to ${step.x2} ${step.z2}`}${step.y === undefined ? "" : ` at y ${step.y}`}${step.fill === undefined ? "" : `, filled with ${step.fill}`}`;
    case "protect_area": return `protect ${step.label} (${step.radius} blocks around ${step.player ?? `${step.x} ${step.y} ${step.z}`})`;
    case "release_area": return `release area #${step.area}`;
    case "farm": return `farm ${step.crop ?? "the crop it has"} (${step.size}x${step.size})${step.x === undefined ? "" : ` at ${step.x} ${step.y} ${step.z}`}`;
    case "build": return `build a ${step.size} ${step.structure}${step.x === undefined || step.y === undefined || step.z === undefined ? "" : ` at ${step.x} ${step.y} ${step.z}`}`;
  }
}
