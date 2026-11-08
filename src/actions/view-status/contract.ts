import { MOB_AGES } from "../../world/mob-age.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { actionResultSchema, type ActionOutput } from "../action.js";
import { toolSnapshotSchema } from "../../world/tool-tiers.js";

export const VIEW_STATUS = "view_status" as const;

export const VIEW_STATUS_DESCRIPTION =
  "View the bot's live situation in one read: health, hunger, and saturation; the world clock with day or night, " +
  "the ticks until that changes, and whether the bot is asleep or it is raining; exact position, dimension, footing, " +
  "and compass heading; every carried stack with its slot, the free slot count, the held item, and worn equipment; " +
  "each carried food with the hunger points and saturation one restores; " +
  "the armour points, the armour worn per slot and carried unworn, the light at the feet with the open sky above, the fight reflex's gear, and the respawn point; " +
  "remaining item durability, best carried tool and armour (item, rank in its family, durability), bucket kinds, observed air supply in ticks, burning and lava contact, and current physical ownership/action; " +
  "which movements the inventory unlocks: no carried water bucket caps every route at a three-block fall and disarms the emergency fall save, and pillaring and bridging need a carried scaffold block; " +
  "the players and hostile mobs nearby; every loaded dropped item, nearest first; and every loaded mob species and observed age group with its count, whether it is hostile, and the " +
  "nearest one's position, at any distance, so a cow sixty blocks off is listed. " +
  "The End fight section lists loaded crystal IDs and observed cage status, dragon phase name and health, the estimated perched head or tentative landing head position, and dragon breath clouds. " +
  "Use it to check state before and after actions, to wait for night, to pick a species to hunt, " +
  "or to count items exactly. " +
  "It also refreshes main.bot_status, main.bot_inventory, and main.bot_tools for query_bot_data.";

export const viewStatusInputSchema = z.strictObject({});
export type ViewStatusInput = z.input<typeof viewStatusInputSchema>;
export type ViewStatusRequest = Record<string, never>;

export function parseViewStatusRequest(raw: unknown): ViewStatusRequest {
  viewStatusInputSchema.parse(raw ?? {});
  return {};
}

const positionSchema = z.strictObject({ x: z.number(), y: z.number(), z: z.number() });

export const INVENTORY_LOCATIONS = ["main", "hotbar", "head", "torso", "legs", "feet", "off-hand"] as const;

/**
 * minecraft-data's own entity type, for the entities it files under a mob
 * category. `mob` is its bucket for the ones it gives no finer type - slimes,
 * ghasts, phantoms, shulkers, iron golems - and the five named types cover
 * everything else. Nothing outside a mob category carries one of these types,
 * so an entity that does is exactly a loaded mob.
 */
export const MOB_KINDS = ["animal", "passive", "water_creature", "ambient", "hostile", "mob"] as const;
export type MobKind = (typeof MOB_KINDS)[number];

/**
 * Why a movement the bot is otherwise capable of is unavailable right now.
 *
 * Each reason names the one thing to change: carry a water bucket, leave a
 * dimension that boils it, turn the survival policy's flag back on, or carry a
 * block worth placing. A movement with an empty list is available.
 */
export const MOBILITY_BLOCKERS = [
  "no_water_bucket",
  "water_evaporates_here",
  "policy_disabled",
  "no_scaffold_block",
] as const;
export type MobilityBlocker = (typeof MOBILITY_BLOCKERS)[number];

export const DRAGON_PHASE_NAMES = [
  "holding_pattern",
  "strafing_player",
  "landing_approach",
  "landing",
  "takeoff",
  "sitting_flaming",
  "sitting_scanning",
  "sitting_attacking",
  "charging_player",
  "dying",
  "hovering",
] as const;

export const nearbyMobSchema = z.strictObject({
  name: z.string().min(1),
  kind: z.enum(MOB_KINDS),
  hostile: z
    .boolean()
    .describe("The species is in the game's hostile mob category, the one collect_mob_drop refuses without a shield."),
  age: z.enum(MOB_AGES),
  count: z.number().int().positive().describe("Loaded mob count for this species and observed age group."),
  nearest: z.strictObject({
    entityId: z.number().int().nonnegative(),
    distance: z.number().nonnegative(),
    position: positionSchema,
  }),
});

export const inventoryStackSchema = z.strictObject({
  slot: z.number().int().nonnegative(),
  location: z.enum(INVENTORY_LOCATIONS),
  name: z.string().min(1),
  count: z.number().int().positive(),
  held: z.boolean(),
  durability: z
    .strictObject({ remaining: z.number().nonnegative(), maximum: z.number().positive() })
    .nullable()
    .describe("Remaining and maximum durability; null when durability is not reported or not applicable."),
  families: z
    .array(z.string())
    .describe("The item's families (sword, pickaxe, helmet, food, bed...) from the server's tags, else the tags shipped for the version; sorted, empty when none."),
});

export const itemFamiliesSourceSchema = z.strictObject({
  source: z.enum(["server", "shipped", "none"]).describe("server: the server's tags packet arrived; shipped: the tags shipped for the version; none: neither exists."),
  version: z.string().describe("The server's version for server, the shipped file's version for shipped."),
  overrides: z.array(z.string()).describe("Namespaces of the family override files in use."),
});

export const liveSituationSchema = z.strictObject({
  endFight: z
    .strictObject({
      dragons: z.array(
        z.strictObject({
          entityId: z.number().int(),
          position: positionSchema,
          health: z.number().nullable(),
          phase: z.number().int().nullable(),
          phaseName: z.enum(DRAGON_PHASE_NAMES).nullable(),
          perched: z.boolean(),
          headEstimate: positionSchema.nullable().describe("Estimated current head from the observed perched pose; null while flying."),
          landingHeadEstimate: positionSchema
            .nullable()
            .describe("Predicted head after landing from observed fountain geometry; direction may change."),
        }),
      ),
      crystals: z.array(
        z.strictObject({
          entityId: z.number().int(),
          position: positionSchema,
          cage: z
            .enum(["present", "none_observed", "unknown"])
            .describe(
              "Loaded-block observation around the crystal. Present includes a partially opened cage while any iron bars remain; none_observed means the full probe was loaded with no bars; unknown means unloaded cells could hide bars.",
            ),
        }),
      ),
      clouds: z.array(
        z.strictObject({ id: z.number().int(), x: z.number(), y: z.number(), z: z.number(), radius: z.number() }),
      ),
    })
    .describe(
      "Loaded End fight entities only. Missing entities do not imply death or a cleared arena. Current perched head estimates and tentative landing predictions are separate; neither predicts exactly when takeoff will occur.",
    ),
  botId: z.string().min(1),
  observedAt: z.string(),
  dimension: z.string(),
  gameMode: z.string(),
  difficulty: z.string().describe("Server difficulty: peaceful (hostile mobs never spawn), easy, normal or hard; unknown before the server said."),
  lastDeath: z.strictObject({
    dimension: z.string(),
    position: positionSchema,
    observedAt: z.string(),
    cause: z.string().nullable(),
  }).nullable(),
  vitals: z.strictObject({
    health: z.number(),
    food: z.number(),
    saturation: z.number(),
    airSupplyTicks: z
      .number()
      .int()
      .nullable()
      .describe("Own entity air_supply metadata in ticks; null until observed. May be negative during drowning."),
    burning: z.boolean().nullable().describe("Own entity burning flag; null until observed."),
    burn: z.strictObject({ ticks: z.number(), hp: z.number() }).nullable(),
    armour: z.number().nullable().describe("Armour points the server counts (generic.armor); 0 with no piece worn; null when a piece is worn and the server told none."),
    armourToughness: z.number().nullable().describe("Armour toughness (generic.armor_toughness); same null rule as armour."),
  }),
  armourWorn: z
    .array(z.strictObject({ slot: z.enum(["head", "torso", "legs", "feet"]), item: z.string().nullable() }))
    .describe("The four armour slots as worn, an empty one with item null."),
  armourCarried: z
    .array(z.strictObject({ item: z.string(), count: z.number().int().positive(), slot: z.enum(["head", "torso", "legs", "feet"]) }))
    .describe("Armour pieces in the main inventory and hotbar (not worn), summed per item, each with the slot it is for."),
  light: z
    .strictObject({
      sky: z.number().int().nullable().describe("Sky light at the feet cell (15 under open sky by day); null where the client holds no light data."),
      block: z.number().int().nullable().describe("Block light at the feet cell; null where the client holds no light data."),
      openSkyAbove: z.number().int().positive().nullable().describe("Blocks up to the first cell with sky light 15 when the feet cell is below 15; null when the feet are under open sky, or a cell on the way has no light data, or none is found."),
    })
    .describe("The light at the bot's feet, as the chunk data the server sent."),
  combat: z
    .strictObject({
      melee: z.string().nullable().describe("The melee weapon the fight reflex picks; null: bare hands."),
      bow: z.string().nullable().describe("The best carried bow, with or without arrows."),
      arrows: z.number().int().nonnegative().describe("Arrows carried, the off-hand included."),
      shield: z.string().nullable(),
    })
    .describe("What the fight reflex has to work with."),
  respawn: z
    .strictObject({ kind: z.enum(["bed", "world_spawn"]), position: positionSchema, distance: z.number().nonnegative().nullable() })
    .nullable()
    .describe("Where the bot would wake after dying: a bed slept in this session, else the world spawn; distance null in another dimension."),
  mobility: z
    .strictObject({
      maximumDrop: z
        .number()
        .int()
        .nonnegative()
        .describe("Blocks a route falls unassisted. A longer descent is planned only as a water-bucket drop."),
      waterBuckets: z
        .number()
        .int()
        .nonnegative()
        .describe("Carried water buckets. At zero, both the planned bucket drop and the emergency fall save are unavailable."),
      bucketDrop: z
        .strictObject({
          available: z.boolean(),
          maximumBlocks: z
            .number()
            .int()
            .nonnegative()
            .describe("Longest drop a route may plan while this is available; zero when it is not."),
          blockedBy: z.array(z.enum(MOBILITY_BLOCKERS)),
        })
        .describe("Planned water-bucket drops, the only way a route descends further than maximumDrop in one move."),
      fallSave: z
        .strictObject({ available: z.boolean(), blockedBy: z.array(z.enum(MOBILITY_BLOCKERS)) })
        .describe("The automatic water rescue for an unplanned damaging fall, such as one a shove or a collapse starts."),
      scaffold: z
        .strictObject({
          available: z.boolean(),
          item: z.string().nullable().describe("The carried block automatic placement spends next; null when none is admitted."),
          blocks: z.number().int().nonnegative().describe("How many of that block are carried."),
          blockedBy: z.array(z.enum(MOBILITY_BLOCKERS)),
        })
        .describe("Automatic scaffold placement, which is what lets a route pillar up to a cell or bridge a gap."),
      digStraightDown: z
        .strictObject({ available: z.boolean(), blockedBy: z.array(z.enum(MOBILITY_BLOCKERS)) })
        .describe(
          "Whether a route may dig the block beneath the bot and descend straight down. When unavailable, routes still descend by digging a staircase.",
        ),
    })
    .describe(
      "Which movements the carried inventory and the survival policy unlock right now, and what blocks the rest. " +
        "This reports the route planner's standing limits, not the terrain: an available drop still needs a loaded safe landing.",
    ),
  activity: z
    .strictObject({
      owner: z.enum(["idle", "foreground", "yielding", "takeover"]),
      activeAction: z.strictObject({ action: z.string(), startedAt: z.string() }).nullable(),
    })
    .describe(
      "Current physical session owner and action. The reply's survival field also reports the request, reserved owner, response phase, budgets, answered scopes, observations and the survival policy.",
    ),
  clock: z.strictObject({
    timeOfDay: z.number().int(),
    phase: z
      .enum(["day", "night"])
      .nullable()
      .describe("Overworld daylight phase; null outside the Overworld, where daylight is absent or unknown."),
    ticksUntilChange: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .describe("Ticks until the Overworld phase changes; null outside the Overworld."),
    minutesUntilChange: z
      .number()
      .nonnegative()
      .nullable()
      .describe("Minutes until the Overworld phase changes; null outside the Overworld."),
    sleeping: z.boolean(),
    raining: z.boolean(),
  }),
  vehicle: z
    .strictObject({ name: z.string().min(1), id: z.number().int() })
    .nullable()
    .describe("The vehicle the bot sits in (boat, minecart, horse...) from the client view; null on foot."),
  position: z.strictObject({
    x: z.number(),
    y: z.number(),
    z: z.number(),
    chunkX: z.number().int(),
    chunkZ: z.number().int(),
    headingDegrees: z.number(),
    onGround: z.boolean(),
    inWater: z.boolean(),
    inLava: z.boolean().nullable().describe("Mineflayer physics lava contact; null when unavailable."),
  }),
  inventory: z.strictObject({
    usedSlots: z.number().int().nonnegative(),
    freeSlots: z.number().int().nonnegative(),
    stacks: z.array(inventoryStackSchema),
    /** Every carried food kind with what one restores (game data), most filling first. */
    foods: z.array(
      z.strictObject({
        name: z.string(),
        count: z.number().int().positive(),
        points: z.number().nonnegative().describe("Hunger points one restores."),
        saturation: z.number().nonnegative().describe("Saturation one restores."),
      }),
    ),
  }),
  tools: toolSnapshotSchema,
  item_families: itemFamiliesSourceSchema.describe("Where the stacks' families come from; a stack's families are those of this source."),
  nearby: z.strictObject({
    rangeBlocks: z.number().positive(),
    players: z.array(
      z.strictObject({
        username: z.string(),
        distance: z.number().nonnegative().nullable(),
        position: positionSchema.nullable(),
      }),
    ),
    hostiles: z.array(
      z.strictObject({ name: z.string(), distance: z.number().nonnegative(), position: positionSchema }),
    ),
    /** Every loaded mob by species, nearest first. Unlike the lists around it, no distance bounds this one. */
    mobs: z.array(nearbyMobSchema),
    /** Every loaded dropped item, nearest first, up to sixteen; no distance bounds this one either. */
    droppedItems: z.array(
      z.strictObject({
        name: z.string(),
        count: z.number().int().positive(),
        distance: z.number().nonnegative(),
        position: positionSchema,
      }),
    ),
  }),
});

export type LiveSituation = z.output<typeof liveSituationSchema>;

export const viewStatusResultSchema = actionResultSchema({ situation: liveSituationSchema });
export type ViewStatusResult = z.output<typeof viewStatusResultSchema>;
export type ViewStatusOutput = ActionOutput<typeof VIEW_STATUS, ViewStatusResult>;

export const viewStatusAnnotations = {
  openWorldHint: false,
} satisfies ToolAnnotations;
