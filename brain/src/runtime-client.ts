import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";

export interface Position {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** A box this bot never digs or scaffolds in (ADR-012), as the runtime reports it. */
export interface ProtectedArea {
  readonly regionId: number;
  readonly label: string;
  readonly owner: string;
  readonly min: Position;
  readonly max: Position;
}

export interface AreaRequest {
  readonly min: Position;
  readonly max: Position;
  /** Omitted: the bot's own. */
  readonly owner?: string;
  readonly label: string;
  readonly reason: string;
}

export type AreaOutcome =
  | { readonly status: "succeeded"; readonly area: ProtectedArea }
  | { readonly status: "failed"; readonly error: string };

export interface NearbyPlayer {
  readonly username: string;
  /** Null when the player is online but not loaded around the bot. */
  readonly position: Position | null;
}

/** A carried stack; `durability` only for items that wear out (tools, armour), as the runtime reports it. */
export interface CarriedStack {
  readonly name: string;
  readonly count: number;
  readonly durability?: { readonly remaining: number; readonly maximum: number } | null;
}

/** A carried food kind and what one restores (game data). */
export interface CarriedFood {
  readonly name: string;
  readonly count: number;
  readonly points: number;
  readonly saturation: number;
}

/** A loaded mob species: whether the game files it as hostile, how many are loaded, how far the nearest is. */
export interface NearbyMob {
  readonly name: string;
  readonly hostile: boolean;
  readonly count: number;
  readonly distance: number;
  /** Where the nearest one stands, when the runtime said. */
  readonly position?: Position;
}

/** The slice of `view_status` the brain reasons about. */
export interface BotSnapshot {
  readonly position: Position;
  readonly health: number;
  readonly food: number;
  readonly inventory: readonly CarriedStack[];
  /** Carried foods, most filling first; empty when it carries none. */
  readonly foods: readonly CarriedFood[];
  /** Loaded mob species, nearest first. */
  readonly mobs: readonly NearbyMob[];
  readonly players: readonly NearbyPlayer[];
  /** The survival policy's revision and the setting the brain manages; null when the runtime did not report it. */
  readonly policy: { readonly revision: string; readonly digStraightDown: boolean; readonly scaffoldBlocks?: readonly string[] } | null;
  /** The overworld's day or night (null elsewhere) and minutes until it changes; unset when the runtime did not say. */
  readonly clock?: { readonly phase: "day" | "night" | null; readonly minutesUntilChange: number | null };
  /** Her best carried tool and worn armour per class (`view_status` tools; item null: none); unset when not reported. */
  readonly gear?: {
    readonly tools: readonly { readonly class: string; readonly item: string | null }[];
    readonly armour: readonly { readonly class: string; readonly item: string | null }[];
  };
}

export interface PlayerMessage {
  readonly username: string;
  readonly channel: "chat" | "whisper";
  readonly message: string;
  /** The runtime's own check: the message names the bot's username as a word. */
  readonly addressed: boolean;
}

export type ActionStatus = "succeeded" | "partial" | "failed" | "cancelled";

/** Foreground tools the brain drives (all are body-locking tasks in the runtime). */
export type ForegroundTool =
  | "navigate" | "collect_block" | "drop_item"
  | "craft_item" | "smelt_item" | "eat_food" | "equip" | "sleep" | "collect_mob_drop" | "build_structure" | "note_save" | "note_delete"
  | "tend_crops" | "use_bucket" | "raw_action";

export type ForegroundState =
  | { readonly state: "pending"; readonly actionId: string }
  | {
    readonly state: "settled";
    readonly actionId: string;
    readonly status: ActionStatus;
    readonly error: string | null;
    /** The action's whole `result` (e.g. `build_structure`'s `structure` audit), when the runtime returned one. */
    readonly result?: Readonly<Record<string, unknown>>;
  }
  | {
    readonly state: "refused";
    readonly code: string;
    readonly error: string;
    readonly activeActionId: string | null;
    readonly unretrievedActionId: string | null;
  };

export interface ItemCount {
  readonly item: string;
  readonly count: number;
}

/** The runtime's recursive crafting plan for a batch (`view_crafting_requirements`), reduced to what the brain uses. */
export interface CraftingNeeds {
  /** `unknown`: Minecraft has no such item. `uncraftable`: no recipe (gathered, not crafted). */
  readonly status: "ready" | "missing_materials" | "uncraftable" | "planner_failed" | "unknown";
  /** Leaf materials the bot lacks, including a crafting table's own when none is carried or in reach. */
  readonly missing: readonly ItemCount[];
  /** Why there is no plan, in the runtime's words (an unknown name comes with the registry names close to it). */
  readonly error?: string;
}

/** One furnace recipe: any one of `inputs` cooks into `count` of `output`. */
export interface SmeltingRecipe {
  readonly output: string;
  readonly count: number;
  readonly inputs: readonly string[];
}

/** One block an item drops from by an ordinary break (`view_block_drops`). */
export interface DropSource {
  readonly block: string;
  /** How often one break yields it. */
  readonly chance: number;
  /** A crop the item grows into (wheat for wheat seeds): breaking it takes from a farm. */
  readonly planted: boolean;
  /** The item the crop is planted from, for a planted source. */
  readonly seed?: string;
}

/** One mob an item drops from when killed (`view_block_drops`). */
export interface MobSource {
  readonly mob: string;
  readonly chance: number;
  /** The game counts the species as hostile: a fight, not a hunt. */
  readonly hostile: boolean;
}

/** Furnace knowledge for some items: the recipes making each (none: not smeltable) and how far each fuel goes. */
export interface SmeltingKnowledge {
  /** `unknown`: Minecraft has no such item (or no smelting data ships for this version). */
  readonly status: "known" | "unknown";
  readonly recipes: Readonly<Record<string, readonly SmeltingRecipe[]>>;
  /** Items one of each fuel smelts. */
  readonly fuels: Readonly<Record<string, number>>;
}

/** The tool class a block is mined with (game data), null when no tool helps. */
export type ToolClass = "pickaxe" | "shovel" | "axe" | "hoe";

/**
 * Game data for one block name: the tool class it is mined with, whether it is solid ground, and the tools without
 * which it drops nothing (cheapest tier first; null when a bare hand will do).
 */
export interface BlockKind {
  readonly tool: ToolClass | null;
  readonly solid: boolean;
  /** Whether the block fills its whole cell (dirt, planks), unlike stairs, slabs, panes or doors; from the runtime's geometry. */
  readonly fullCube?: boolean;
  readonly harvest: readonly string[] | null;
  /** The game's block tags it belongs to (`logs`, `crops`...); only a `blockKinds` lookup reports them. */
  readonly tags?: readonly string[];
}

/** Where a block was seen: the middle of an explored chunk holding it, at the height asked from. */
export interface SeenBlock {
  readonly dimension: string;
  readonly x: number;
  readonly z: number;
}

/** A block found by name or selector: where, and which block it is. */
export interface FoundBlock extends Position {
  readonly name: string;
}

/** The blocks of a box as read by the runtime: name by position, and what each name is. */
export interface BlockArea {
  /** Block name at `x,y,z` (keys from {@link areaKey}). */
  readonly blocks: ReadonlyMap<string, string>;
  readonly kinds: Readonly<Record<string, BlockKind>>;
}

export function areaKey(x: number, y: number, z: number): string {
  return `${x},${y},${z}`;
}

/** What a brain needs from one bot. Implemented over MCP ({@link McpBotRuntime}) and by fakes in tests. */
/** How much of the ground along a line is water, from the chunks of it the bot explored. */
export interface WaterShare {
  readonly chunks: number;
  readonly share: number;
}

/**
 * The chunk columns (x, z) a straight line from `from` to `to` crosses, `from`'s own excluded, in order: sampled every
 * 4 blocks, so no chunk the line goes through is skipped.
 */
export function chunksAlong(from: { readonly x: number; readonly z: number }, to: { readonly x: number; readonly z: number }): readonly (readonly [number, number])[] {
  const chunkOf = (x: number, z: number) => [Math.floor(x / 16), Math.floor(z / 16)] as const;
  const [startX, startZ] = chunkOf(from.x, from.z);
  const length = Math.hypot(to.x - from.x, to.z - from.z);
  const chunks: (readonly [number, number])[] = [];
  const seen = new Set<string>([`${startX},${startZ}`]);
  for (let walked = 4; walked < length + 4; walked += 4) {
    const t = Math.min(1, walked / Math.max(length, 1e-9));
    const chunk = chunkOf(from.x + (to.x - from.x) * t, from.z + (to.z - from.z) * t);
    if (seen.has(`${chunk[0]},${chunk[1]}`)) continue;
    seen.add(`${chunk[0]},${chunk[1]}`);
    chunks.push(chunk);
  }
  return chunks;
}

/** How far from `from` the first of these chunks (in order along a line) that is not `known` is; null when all are. */
export function firstUnseen(from: { readonly x: number; readonly z: number }, chunks: readonly (readonly [number, number])[], known: ReadonlySet<string>): number | null {
  const unseen = chunks.find(([x, z]) => !known.has(`${x},${z}`));
  return unseen === undefined ? null : Math.round(Math.hypot(unseen[0] * 16 + 8 - from.x, unseen[1] * 16 + 8 - from.z));
}

export interface BotRuntime {
  status(): Promise<BotSnapshot>;
  /**
   * What crafting these items would take from the current inventory; crafts nothing. `prefer`: materials to plan with,
   * in order, where recipes accept several and none is carried (the woods growing nearby).
   */
  craftingNeeds(items: readonly ItemCount[], prefer?: readonly string[]): Promise<CraftingNeeds>;
  /** The furnace recipes making these items, from the game data the runtime ships (`view_smelting_recipes`). */
  smeltingRecipes(items: readonly string[]): Promise<SmeltingKnowledge>;
  /**
   * The blocks each item drops from by an ordinary break, wild blocks before planted crops, the likeliest first
   * (`view_block_drops`, the game's loot tables); none for an item no block drops.
   */
  blockSources(items: readonly string[]): Promise<Readonly<Record<string, readonly DropSource[]>>>;
  /** The mobs each item drops from when killed, likeliest first, hostile ones marked (`view_block_drops`). */
  mobSources(items: readonly string[]): Promise<Readonly<Record<string, readonly MobSource[]>>>;
  /** What each block drops when broken without silk touch or shears (`view_block_drops`, the game's loot tables). */
  blockDrops(blocks: readonly string[]): Promise<Readonly<Record<string, readonly string[]>>>;
  /** Every block of the box between two corners (inclusive), read in slices through `view_blocks`. */
  blocksIn(min: Position, max: Position): Promise<BlockArea>;
  /** The nearest loaded blocks of that name (or the runtime's `logs` selector: any wood), nearest first (`view_blocks` find). */
  findBlocks(name: string, limit: number): Promise<readonly FoundBlock[]>;
  /**
   * The explored chunk nearest to `from`, farther than `beyond` blocks, where this block was seen (the bot data's
   * frontier map records the materials of every chunk it loaded), with its dimension; null when none. Closer chunks
   * are left out: the caller has just searched them, so a record there is stale (live 2026-10-03: logs cut long ago
   * sent Vex to "7 blocks south-west" again and again).
   */
  seenAt(block: string, from: Position, beyond: number): Promise<SeenBlock | null>;
  /** The overworld places (chunk middles) it saw `block` in, farther than `beyond`, nearest first, at most `limit`. */
  seenPlaces(block: string, from: Position, beyond: number, limit: number): Promise<readonly SeenBlock[]>;
  /**
   * The explored chunks (overworld) a straight line from `from` to `to` crosses, and their mean surface water share
   * (0..1, the bot data's frontier map); null when it crosses none it has explored.
   */
  waterAlong(from: Position, to: Position): Promise<WaterShare | null>;
  /** The middle of the nearest explored chunk (overworld) whose surface is mostly land; null when it knows none. */
  nearestLand(from: Position): Promise<{ readonly x: number; readonly z: number } | null>;
  /**
   * How far along the straight line from `from` toward `to` the first chunk it has never seen is (blocks, to that
   * chunk's middle); null when every chunk on the line is explored.
   */
  unseenAlong(from: Position, to: Position): Promise<number | null>;
  /** Game data of these block names (`view_blocks` kinds); a name Minecraft has no block for is left out. */
  blockKinds(names: readonly string[]): Promise<Readonly<Record<string, BlockKind>>>;
  /** One public chat line; runs beside the foreground action (chat does not take the body). */
  /** Public chat, or with `to` a whisper to that player online (`send_message`). */
  say(message: string, to?: string): Promise<{ readonly status: ActionStatus; readonly error: string | null }>;
  /**
   * Whether routes may dig the block under the bot (a survival-policy setting, merged with the others). The runtime
   * resets every override on death and dimension change, so the brain checks it again from each snapshot.
   */
  setDigStraightDown(allowed: boolean, revision: string): Promise<boolean>;
  /** The blocks routes may place as scaffolding (runtime survival policy `navigation.scaffold_blocks`). */
  setScaffoldBlocks(blocks: readonly string[], revision: string): Promise<boolean>;
  /** Incoming player messages since the last call (the runtime keeps the read cursor). */
  readMessages(): Promise<readonly PlayerMessage[]>;
  /** One read-only SQL statement over the bot's data (`query_bot_data`), as rows of cells in column order. */
  queryBotData(sql: string): Promise<readonly (readonly (string | number | null)[])[]>;
  submit(tool: ForegroundTool, input: Readonly<Record<string, unknown>>, rationale: string, waitMs: number): Promise<ForegroundState>;
  wait(actionId: string, timeoutMs: number): Promise<ForegroundState>;
  cancel(actionId: string, reason: string): Promise<void>;
  /** Protects a box (`protect_region`, ADR-012); runs beside the foreground action. */
  protectRegion(request: AreaRequest): Promise<AreaOutcome>;
  /** Removes one protected box (`unprotect_region`). */
  unprotectRegion(regionId: number): Promise<{ readonly status: "succeeded" } | { readonly status: "failed"; readonly error: string }>;
  /** Every protected box in this bot's data, oldest first. */
  protectedRegions(): Promise<readonly ProtectedArea[]>;
  close(): Promise<void>;
}

const positionSchema = z.object({ x: z.number(), y: z.number(), z: z.number() });

const viewStatusSchema = z.object({
  result: z.object({
    situation: z.object({
      position: positionSchema,
      vitals: z.object({ health: z.number(), food: z.number() }),
      inventory: z.object({
        stacks: z.array(z.object({ name: z.string(), count: z.number(), durability: z.object({ remaining: z.number(), maximum: z.number() }).nullable().default(null) })),
        foods: z.array(z.object({ name: z.string(), count: z.number(), points: z.number(), saturation: z.number() })).default([]),
      }),
      nearby: z.object({
        players: z.array(z.object({ username: z.string(), position: positionSchema.nullable() })),
        mobs: z.array(z.object({ name: z.string(), hostile: z.boolean().default(false), count: z.number(), nearest: z.object({ distance: z.number(), position: positionSchema.optional() }) })).default([]),
      }),
      clock: z.object({ phase: z.enum(["day", "night"]).nullable(), minutesUntilChange: z.number().nullable() }).optional(),
      tools: z.object({
        tools: z.array(z.object({ class: z.string(), item: z.string().nullable() })),
        armour: z.array(z.object({ class: z.string(), item: z.string().nullable() })),
      }).optional(),
    }),
  }),
  survivalPolicy: z.object({
    revision: z.string(),
    effective: z.object({ navigation: z.object({ dig_straight_down: z.boolean().default(true), scaffold_blocks: z.array(z.string()).default([]) }) }),
  }).optional(),
});

const policyEditSchema = z.object({ result: z.object({ status: z.string() }) });

const craftingRequirementsSchema = z.object({
  result: z.object({
    status: z.string(),
    error: z.string().optional(),
    requirements: z.object({
      plan: z.object({
        status: z.enum(["ready", "missing_materials", "uncraftable", "planner_failed"]),
        missingMaterials: z.array(z.object({ item: z.string(), count: z.number() })),
      }).optional(),
    }).optional(),
  }),
});

const smeltingRecipesSchema = z.object({
  result: z.object({
    status: z.string(),
    smelting: z.object({
      items: z.array(z.object({ item: z.string(), recipes: z.array(z.object({ output: z.string(), count: z.number(), inputs: z.array(z.string()) })) })),
      fuels: z.array(z.object({ item: z.string(), itemsSmelted: z.number() })),
    }).optional(),
  }),
});

const blockDropsSchema = z.object({
  result: z.object({
    drops: z.object({
      items: z.array(z.object({
        item: z.string(),
        sources: z.array(z.object({ block: z.string(), chance: z.number(), planted: z.boolean() })),
        mobs: z.array(z.object({ mob: z.string(), chance: z.number(), hostile: z.boolean() })).default([]),
      })),
      blocks: z.array(z.object({
        block: z.string(),
        drops: z.array(z.object({ item: z.string(), tool: z.string().optional() })),
      })).default([]),
    }).optional(),
  }),
});

const blockKindSchema = z.object({
  tool: z.enum(["pickaxe", "shovel", "axe", "hoe"]).nullable(),
  solid: z.boolean(),
  full_cube: z.boolean().optional(),
  harvest: z.array(z.string()).nullable().default(null),
  tags: z.array(z.string()).optional(),
}).transform(({ full_cube, ...kind }) => (full_cube === undefined ? kind : { ...kind, fullCube: full_cube }));

const viewBoxSchema = z.object({
  result: z.object({
    blocks: z.object({
      box: z.object({
        layers: z.array(z.object({ y: z.number(), rows: z.array(z.object({ z: z.number(), blocks: z.array(z.string()) })) })),
        kinds: z.record(z.string(), blockKindSchema).default({}),
      }).nullable(),
      find: z.array(z.object({ listed: z.array(positionSchema.extend({ name: z.string() })) })).nullable(),
      kinds: z.record(z.string(), blockKindSchema).optional(),
    }).optional(),
  }),
});

/** `view_blocks` box limits (src/actions/view-blocks/contract.ts): 9 wide, 7 high per read. */
const BOX_HALF_WIDTH = 4;
const BOX_HALF_HEIGHT = 3;

const areaSchema = z.object({ regionId: z.number(), label: z.string(), owner: z.string(), min: positionSchema, max: positionSchema });
const regionResultSchema = z.object({
  result: z.object({ status: z.string(), error: z.string().optional(), region: areaSchema.nullable().optional() }),
});

const sayResultSchema = z.object({
  result: z.object({ status: z.enum(["succeeded", "partial", "failed", "cancelled"]), error: z.string().optional() }),
});

const queryResultSchema = z.object({
  result: z.object({
    status: z.string(),
    error: z.string().optional(),
    query: z.object({ rows: z.array(z.array(z.union([z.string(), z.number(), z.null()]))) }).optional(),
  }),
});

const eventsSchema = z.object({
  result: z.object({
    events: z.array(z.object({ type: z.string(), payload: z.unknown() })),
    remainingEventCount: z.number(),
  }),
});

const playerMessagePayloadSchema = z.object({
  username: z.string(),
  channel: z.enum(["chat", "whisper"]),
  direction: z.enum(["incoming", "outgoing"]),
  message: z.string(),
  addressed: z.boolean(),
});

const actionOutputSchema = z.object({
  result: z.looseObject({ status: z.enum(["succeeded", "partial", "failed", "cancelled"]), error: z.string().optional() }),
});

const foregroundDataSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("accepted"), actionId: z.string() }),
  z.object({ state: z.literal("pending"), actionId: z.string() }),
  z.object({ state: z.literal("settled"), actionId: z.string(), output: actionOutputSchema }),
  z.object({ state: z.literal("storage_failed"), actionId: z.string(), error: z.string(), output: actionOutputSchema }),
  z.object({
    state: z.literal("refused"),
    code: z.string(),
    error: z.string(),
    activeActionId: z.string().optional(),
    unretrievedActionId: z.string().optional(),
  }),
]);

const jsonReplySchema = z.object({ response: z.object({ format: z.literal("json"), data: z.unknown() }) });

/** Largest page `read_recent_events` accepts. */
const EVENT_PAGE = 100;

/** The runtime lists a species once per age group: one entry per species, counts added, the nearest distance kept. */
function mobSpecies(groups: readonly { name: string; hostile: boolean; count: number; nearest: { distance: number; position?: Position | undefined } }[]): NearbyMob[] {
  const species = new Map<string, NearbyMob>();
  for (const group of groups) {
    const seen = species.get(group.name);
    const nearest = { distance: group.nearest.distance, ...(group.nearest.position === undefined ? {} : { position: group.nearest.position }) };
    species.set(group.name, seen === undefined
      ? { name: group.name, hostile: group.hostile, count: group.count, ...nearest }
      : { ...seen, count: seen.count + group.count, ...(group.nearest.distance < seen.distance ? nearest : {}) });
  }
  return [...species.values()].sort((a, b) => a.distance - b.distance);
}

/** The runtime's outcome code: the bracketed prefix its errors start with, e.g. `HOSTILE_CONTACT`. */
export function errorCode(error: string | null | undefined): string | null {
  return /^\[([A-Z_]+)\]/u.exec(error ?? "")?.[1] ?? null;
}

/** {@link BotRuntime} over one mine-ai-mcp host's Streamable HTTP endpoint (ADR-002: one MCP connection per bot). */
export class McpBotRuntime implements BotRuntime {
  private constructor(private readonly client: Client) {}

  static async connect(url: string, clientName: string): Promise<McpBotRuntime> {
    const client = new Client({ name: clientName, version: "0.1.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    return new McpBotRuntime(client);
  }

  async status(): Promise<BotSnapshot> {
    const data = viewStatusSchema.parse(await this.call("view_status", {}, "Look around before deciding."));
    const { situation } = data.result;
    return {
      position: situation.position,
      health: situation.vitals.health,
      food: situation.vitals.food,
      inventory: situation.inventory.stacks.map(({ name, count, durability }) => ({ name, count, durability })),
      foods: situation.inventory.foods,
      mobs: mobSpecies(situation.nearby.mobs),
      players: situation.nearby.players,
      ...(situation.clock === undefined ? {} : { clock: situation.clock }),
      ...(situation.tools === undefined ? {} : { gear: situation.tools }),
      policy: data.survivalPolicy === undefined
        ? null
        : {
          revision: data.survivalPolicy.revision,
          digStraightDown: data.survivalPolicy.effective.navigation.dig_straight_down,
          scaffoldBlocks: data.survivalPolicy.effective.navigation.scaffold_blocks,
        },
    };
  }

  async setScaffoldBlocks(blocks: readonly string[], revision: string): Promise<boolean> {
    const reason = "What I am fetching is for my work, not for scaffolding on the way.";
    const input = { operation: "set", expected_revision: revision, changes: { navigation: { scaffold_blocks: [...blocks] } }, lifetime: { kind: "session" }, reason };
    const { result } = policyEditSchema.parse(await this.call("set_survival_policy", input, reason));
    return result.status === "succeeded";
  }

  async setDigStraightDown(allowed: boolean, revision: string): Promise<boolean> {
    const reason = allowed ? "I may dig straight down." : "I never dig straight down: I go down by staircase.";
    const input = { operation: "set", expected_revision: revision, changes: { navigation: { dig_straight_down: allowed } }, lifetime: { kind: "session" }, reason };
    const { result } = policyEditSchema.parse(await this.call("set_survival_policy", input, reason));
    return result.status === "succeeded";
  }

  async craftingNeeds(items: readonly ItemCount[], prefer: readonly string[] = []): Promise<CraftingNeeds> {
    const input = { items: items.map(({ item, count }) => ({ item_name: item, count })), ...(prefer.length > 0 && { prefer: [...prefer] }) };
    const { result } = craftingRequirementsSchema.parse(await this.call("view_crafting_requirements", input, "Work out what crafting these would take."));
    // Only an item Minecraft does not have fails without a plan.
    const plan = result.requirements?.plan;
    if (plan === undefined) return { status: "unknown", missing: [], ...(result.error !== undefined && { error: result.error }) };
    return { status: plan.status, missing: plan.missingMaterials.map(({ item, count }) => ({ item, count })) };
  }

  async smeltingRecipes(items: readonly string[]): Promise<SmeltingKnowledge> {
    const { result } = smeltingRecipesSchema.parse(await this.call("view_smelting_recipes", { items: [...items] }, "Work out what a furnace can make."));
    const smelting = result.smelting;
    const known = result.status === "succeeded" && smelting !== undefined;
    return {
      status: known ? "known" : "unknown",
      recipes: Object.fromEntries((smelting?.items ?? []).map(({ item, recipes }) => [item, recipes])),
      fuels: Object.fromEntries((smelting?.fuels ?? []).map(({ item, itemsSmelted }) => [item, itemsSmelted])),
    };
  }

  async blockSources(items: readonly string[]): Promise<Readonly<Record<string, readonly DropSource[]>>> {
    const { result } = blockDropsSchema.parse(await this.call("view_block_drops", { items: [...items] }, "Work out which blocks drop what I need."));
    return Object.fromEntries((result.drops?.items ?? []).map(({ item, sources }) => [item, sources]));
  }

  async mobSources(items: readonly string[]): Promise<Readonly<Record<string, readonly MobSource[]>>> {
    const { result } = blockDropsSchema.parse(await this.call("view_block_drops", { items: [...items] }, "Work out which animals drop what I need."));
    return Object.fromEntries((result.drops?.items ?? []).map(({ item, mobs }) => [item, mobs]));
  }

  async blockDrops(blocks: readonly string[]): Promise<Readonly<Record<string, readonly string[]>>> {
    const { result } = blockDropsSchema.parse(await this.call("view_block_drops", { blocks: [...blocks] }, "Work out what breaking a block gives."));
    // A drop that needs a tool (silk touch, shears) is not what an ordinary break gives.
    return Object.fromEntries((result.drops?.blocks ?? []).map(({ block, drops }) => [block, [...new Set(drops.filter((drop) => drop.tool === undefined).map((drop) => drop.item))]]));
  }

  async blocksIn(min: Position, max: Position): Promise<BlockArea> {
    const blocks = new Map<string, string>();
    const kinds: Record<string, BlockKind> = {};
    const [W, H] = [BOX_HALF_WIDTH * 2 + 1, BOX_HALF_HEIGHT * 2 + 1];
    for (let x = min.x; x <= max.x; x += W) for (let z = min.z; z <= max.z; z += W) for (let y = min.y; y <= max.y; y += H) {
      const box = { x: x + BOX_HALF_WIDTH, y: y + BOX_HALF_HEIGHT, z: z + BOX_HALF_WIDTH, half_width: BOX_HALF_WIDTH, half_height: BOX_HALF_HEIGHT };
      const read = viewBoxSchema.parse(await this.call("view_blocks", { box }, "Look at the ground I am to work.")).result.blocks?.box;
      if (read === null || read === undefined) continue;
      Object.assign(kinds, read.kinds);
      for (const layer of read.layers) for (const row of layer.rows) row.blocks.forEach((name, index) => {
        const cell = { x: box.x - BOX_HALF_WIDTH + index, y: layer.y, z: row.z };
        if (cell.x <= max.x && cell.y >= min.y && cell.y <= max.y && cell.z >= min.z && cell.z <= max.z) blocks.set(areaKey(cell.x, cell.y, cell.z), name);
      });
    }
    return { blocks, kinds };
  }

  async findBlocks(name: string, limit: number): Promise<readonly FoundBlock[]> {
    const read = viewBoxSchema.parse(await this.call("view_blocks", { find: { block_names: [name], limit } }, `Find ${name}.`)).result.blocks;
    return (read?.find?.[0]?.listed ?? []).map(({ x, y, z, name: found }) => ({ x, y, z, name: found }));
  }

  async seenAt(block: string, from: Position, beyond: number): Promise<SeenBlock | null> {
    // `block` is a Minecraft id (letters, digits, underscore: the step schemas check it), safe inside the literal.
    if (!/^[a-z0-9_]+$/u.test(block)) return null;
    const [x, z, far] = [Math.floor(from.x), Math.floor(from.z), Math.floor(beyond)];
    const squared = `((c.chunk_x * 16 + 8 - (${x})) * (c.chunk_x * 16 + 8 - (${x})) + (c.chunk_z * 16 + 8 - (${z})) * (c.chunk_z * 16 + 8 - (${z})))`;
    // Another dimension is never "close": its coordinates do not compare with these.
    const rows = await this.queryBotData(
      "SELECT c.dimension, c.chunk_x * 16 + 8, c.chunk_z * 16 + 8 FROM frontier_chunk_materials m JOIN frontier_chunks c ON c.chunk_key = m.chunk_key " +
      `WHERE m.material = '${block}' AND (c.dimension <> 'overworld' OR ${squared} > ${far * far}) ` +
      `ORDER BY (c.dimension <> 'overworld'), ${squared} LIMIT 1`,
    );
    const row = rows[0];
    return row === undefined ? null : { dimension: String(row[0]), x: Number(row[1]), z: Number(row[2]) };
  }

  async seenPlaces(block: string, from: Position, beyond: number, limit: number): Promise<readonly SeenBlock[]> {
    if (!/^[a-z0-9_]+$/u.test(block)) return [];
    const [x, z, far, count] = [Math.floor(from.x), Math.floor(from.z), Math.floor(beyond), Math.max(1, Math.floor(limit))];
    const squared = `((c.chunk_x * 16 + 8 - (${x})) * (c.chunk_x * 16 + 8 - (${x})) + (c.chunk_z * 16 + 8 - (${z})) * (c.chunk_z * 16 + 8 - (${z})))`;
    const rows = await this.queryBotData(
      "SELECT c.chunk_x * 16 + 8, c.chunk_z * 16 + 8 FROM frontier_chunk_materials m JOIN frontier_chunks c ON c.chunk_key = m.chunk_key " +
      `WHERE m.material = '${block}' AND c.dimension = 'overworld' AND ${squared} > ${far * far} ORDER BY ${squared} LIMIT ${count}`,
    );
    return rows.map((row) => ({ dimension: "overworld", x: Number(row[0]), z: Number(row[1]) }));
  }

  async waterAlong(from: Position, to: Position): Promise<WaterShare | null> {
    const chunks = chunksAlong(from, to);
    if (chunks.length === 0) return null;
    const rows = await this.queryBotData(
      "SELECT COUNT(*), AVG(surface_water_fraction) FROM frontier_chunks WHERE dimension = 'overworld' AND (" +
      chunks.map(([x, z]) => `(chunk_x = ${x} AND chunk_z = ${z})`).join(" OR ") + ")",
    );
    const [count, share] = rows[0] ?? [0, null];
    return Number(count) === 0 || share === null ? null : { chunks: Number(count), share: Number(share) };
  }

  async unseenAlong(from: Position, to: Position): Promise<number | null> {
    const chunks = chunksAlong(from, to);
    if (chunks.length === 0) return null;
    const rows = await this.queryBotData(
      "SELECT chunk_x, chunk_z FROM frontier_chunks WHERE dimension = 'overworld' AND (" +
      chunks.map(([x, z]) => `(chunk_x = ${x} AND chunk_z = ${z})`).join(" OR ") + ")",
    );
    return firstUnseen(from, chunks, new Set(rows.map((row) => `${Number(row[0])},${Number(row[1])}`)));
  }

  async nearestLand(from: Position): Promise<{ readonly x: number; readonly z: number } | null> {
    const [x, z] = [Math.floor(from.x), Math.floor(from.z)];
    const rows = await this.queryBotData(
      "SELECT chunk_x * 16 + 8, chunk_z * 16 + 8 FROM frontier_chunks WHERE dimension = 'overworld' AND surface_water_fraction < 0.5 " +
      `ORDER BY ((chunk_x * 16 + 8 - (${x})) * (chunk_x * 16 + 8 - (${x})) + (chunk_z * 16 + 8 - (${z})) * (chunk_z * 16 + 8 - (${z}))) LIMIT 1`,
    );
    const row = rows[0];
    return row === undefined ? null : { x: Number(row[0]), z: Number(row[1]) };
  }

  async blockKinds(names: readonly string[]): Promise<Readonly<Record<string, BlockKind>>> {
    const kinds: Record<string, BlockKind> = {};
    // One read per name: an unknown name fails the whole read, and it should only leave itself out.
    for (const name of new Set(names)) {
      const read = viewBoxSchema.parse(await this.call("view_blocks", { kinds: [name] }, `Recall what ${name} is.`)).result.blocks;
      const kind = read?.kinds?.[name];
      if (kind !== undefined) kinds[name] = kind;
    }
    return kinds;
  }

  async say(message: string, to?: string): Promise<{ readonly status: ActionStatus; readonly error: string | null }> {
    const { result } = sayResultSchema.parse(await this.call("send_message", { message, ...(to !== undefined && { to }) }, "Speak in character."));
    return { status: result.status, error: result.error ?? null };
  }

  async queryBotData(sql: string): Promise<readonly (readonly (string | number | null)[])[]> {
    const { result } = queryResultSchema.parse(await this.call("query_bot_data", { sql }, "Remember what I knew."));
    if (result.query === undefined) throw new Error(`[QUERY_FAILED] ${result.error ?? result.status}`);
    return result.query.rows;
  }

  async protectRegion(request: AreaRequest): Promise<AreaOutcome> {
    const input = {
      corner_a: request.min,
      corner_b: request.max,
      label: request.label,
      reason: request.reason,
      ...(request.owner !== undefined && { owner: request.owner }),
    };
    const { result } = regionResultSchema.parse(await this.call("protect_region", input, request.reason));
    if (result.status !== "succeeded" || !result.region) return { status: "failed", error: result.error ?? result.status };
    const { regionId, label, owner, min, max } = result.region;
    return { status: "succeeded", area: { regionId, label, owner, min, max } };
  }

  async unprotectRegion(regionId: number): Promise<{ readonly status: "succeeded" } | { readonly status: "failed"; readonly error: string }> {
    const { result } = regionResultSchema.parse(await this.call("unprotect_region", { region_id: regionId }, "Release a protected area."));
    return result.status === "succeeded" ? { status: "succeeded" } : { status: "failed", error: result.error ?? result.status };
  }

  async protectedRegions(): Promise<readonly ProtectedArea[]> {
    const rows = await this.queryBotData(
      "SELECT region_id, label, owner, min_x, min_y, min_z, max_x, max_y, max_z FROM protected_regions ORDER BY region_id",
    );
    return rows.map((row) => ({
      regionId: Number(row[0]),
      label: String(row[1]),
      owner: String(row[2]),
      min: { x: Number(row[3]), y: Number(row[4]), z: Number(row[5]) },
      max: { x: Number(row[6]), y: Number(row[7]), z: Number(row[8]) },
    }));
  }

  async readMessages(): Promise<readonly PlayerMessage[]> {
    const messages: PlayerMessage[] = [];
    for (;;) {
      const { result } = eventsSchema.parse(await this.call("read_recent_events", { limit: EVENT_PAGE }, "Check for players talking to me."));
      for (const event of result.events) {
        if (event.type !== "player_message") continue;
        const payload = playerMessagePayloadSchema.parse(event.payload);
        if (payload.direction !== "incoming") continue;
        messages.push({ username: payload.username, channel: payload.channel, message: payload.message, addressed: payload.addressed });
      }
      if (result.remainingEventCount === 0) return messages;
    }
  }

  async submit(tool: ForegroundTool, input: Readonly<Record<string, unknown>>, rationale: string, waitMs: number): Promise<ForegroundState> {
    return foregroundState(await this.call(tool, { ...input, submission_id: randomUUID(), wait_timeout_ms: waitMs }, rationale));
  }

  async wait(actionId: string, timeoutMs: number): Promise<ForegroundState> {
    return foregroundState(await this.call("wait_for_action", { action_id: actionId, timeout_ms: timeoutMs }, "Wait for my current action."));
  }

  async cancel(actionId: string, reason: string): Promise<void> {
    await this.call("cancel_foreground_action", { action_id: actionId, reason }, "Stop my current action.");
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  /** Calls a tool in JSON mode and returns `response.data`; refused and failed results are data, not exceptions. */
  private async call(name: string, args: Readonly<Record<string, unknown>>, rationale: string): Promise<unknown> {
    const reply = await this.client.callTool({ name, arguments: { ...args, rationale, response_format: "json" } });
    const parsed = jsonReplySchema.safeParse(reply.structuredContent);
    if (parsed.success) return parsed.data.response.data;
    // Input validation and transport errors come back without structured content, only as text.
    const text = Array.isArray(reply.content) ? reply.content.map((part) => ("text" in part ? String(part.text) : "")).join(" ") : "";
    throw new Error(`[MCP_CALL_FAILED] ${name}: ${text || "no structured response"}`);
  }
}

function foregroundState(data: unknown): ForegroundState {
  const reply = foregroundDataSchema.parse(data);
  switch (reply.state) {
    case "accepted":
    case "pending":
      return { state: "pending", actionId: reply.actionId };
    case "settled":
      return { state: "settled", actionId: reply.actionId, status: reply.output.result.status, error: reply.output.result.error ?? null, result: reply.output.result };
    case "storage_failed":
      // The action ran; only its durable record failed. Report what the body did.
      return { state: "settled", actionId: reply.actionId, status: reply.output.result.status, error: reply.output.result.error ?? reply.error, result: reply.output.result };
    case "refused":
      return {
        state: "refused",
        code: reply.code,
        error: reply.error,
        activeActionId: reply.activeActionId ?? null,
        unretrievedActionId: reply.unretrievedActionId ?? null,
      };
  }
}
