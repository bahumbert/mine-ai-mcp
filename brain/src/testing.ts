import { setTimeout as sleep } from "node:timers/promises";
import type { ChatModel, ChatReply, ChatTurn } from "./chat-model.ts";
import { LlmMind, type LocalizedChat } from "./llm-mind.ts";
import type { Persona } from "./persona.ts";
import type { AreaOutcome, AreaRequest, BotRuntime, BotSnapshot, CraftingNeeds, ForegroundState, ForegroundTool, ItemCount, PlayerMessage, Position, ProtectedArea, SmeltingKnowledge, BlockArea, DropSource, MobSource, BlockKind, ToolClass, FoundBlock, SeenBlock, WaterShare } from "./runtime-client.ts";
import { chunksAlong, firstUnseen } from "./runtime-client.ts";

/** A one-level recipe for the fake crafting planner: `makes` items per application. */
export interface FakeRecipe {
  readonly makes: number;
  readonly needs: readonly ItemCount[];
}

/** Blocks the fake world reports as not solid ground. */
const FAKE_NOT_SOLID = new Set(["air", "water", "lava", "short_grass", "dandelion"]);

/** Drops of blocks that do not drop themselves, for the fake `collect_block`. */
const FAKE_DROPS: Readonly<Record<string, string>> = { stone: "cobblestone", short_grass: "wheat_seeds", fern: "wheat_seeds", iron_ore: "raw_iron" };

/** Exactly the blocks of a small medieval house: carrying them, the build skill gathers nothing. */
export const SMALL_MEDIEVAL_HOUSE: BotSnapshot["inventory"] = [
  { name: "spruce_stairs", count: 42 },
  { name: "oak_planks", count: 36 },
  { name: "oak_log", count: 24 },
  { name: "cobblestone", count: 16 },
  { name: "spruce_slab", count: 7 },
  { name: "glass_pane", count: 3 },
  { name: "oak_door", count: 1 },
];

/** Test double for one bot: scripted durations, recorded calls, no Minecraft. */
export class FakeRuntime implements BotRuntime {
  snapshot: BotSnapshot = {
    position: { x: 0, y: 64, z: 0 },
    health: 20,
    food: 20,
    inventory: [],
    foods: [],
    mobs: [],
    players: [],
    policy: null,
  };
  inbox: PlayerMessage[] = [];
  /** Wait slices each tool stays pending before it succeeds. */
  durations: Partial<Record<ForegroundTool, number>> = {};
  /** Tools that settle as failed with this error. */
  failures: Partial<Record<ForegroundTool, string>> = {};
  /** Tools whose next call throws this error, as the client does when the runtime restarted under it. */
  throwNext: Partial<Record<ForegroundTool, string>> = {};
  /** The action result a failing tool settles with (e.g. a `build_structure` audit). */
  failureResults: Partial<Record<ForegroundTool, Readonly<Record<string, unknown>>>> = {};
  /** What each next `drop_item` settles with (the runtime's `drop.dropped` counts); none queued: a bare success. */
  dropOutcomes: { readonly status: "succeeded" | "partial" | "failed"; readonly error: string | null; readonly dropped: readonly { readonly item: string; readonly dropped: number }[]; readonly effect?: () => void }[] = [];
  /** Returned by the next submit instead of accepting it. */
  refuseNext: Extract<ForegroundState, { state: "refused" }> | null = null;
  /** The next call of that tool fails once with this error, after `effect` (what it got done before failing). */
  failNext: Partial<Record<ForegroundTool, { readonly error: string; readonly effect?: () => void; readonly result?: Readonly<Record<string, unknown>> }>> = {};
  /** Recipes known to the fake crafting planner; items without one are uncraftable. */
  recipes: Readonly<Record<string, FakeRecipe>> = {};
  /** Items whose recipes the fake planner cannot plan (Minecraft: coal, iron ingots, made back from their blocks). */
  unplannable: readonly string[] = [];
  /** Furnace recipes known to the fake: output → inputs (any one of them); others are not smeltable. */
  smelting: Readonly<Record<string, readonly string[]>> = {};
  /**
   * Blocks each item drops from (the runtime's loot tables, in its order); an item not listed drops from the block of
   * its own name, unless it is in `notDropped`.
   */
  dropSources: Readonly<Record<string, readonly DropSource[]>> = {
    cobblestone: [{ block: "stone", chance: 1, planted: false }],
    wheat_seeds: [{ block: "short_grass", chance: 0.125, planted: false }, { block: "fern", chance: 0.125, planted: false }, { block: "wheat", chance: 1, planted: true }],
    raw_iron: [{ block: "iron_ore", chance: 1, planted: false }],
  };
  /** Items no block drops (`dropSources` answers none). */
  notDropped: ReadonlySet<string> = new Set(["water_bucket", "bucket", "iron_ingot", "glass", "glass_pane"]);
  /** Items one of each fuel smelts, as the runtime reports them. */
  fuels: Readonly<Record<string, number>> = { coal: 8, charcoal: 8, oak_planks: 1.5, spruce_planks: 1.5, oak_log: 1.5, spruce_log: 1.5, stick: 0.5 };
  /** Successful `collect_block`, `craft_item` and `smelt_item` calls change the snapshot's inventory. */
  simulateInventory = false;
  /** Every foreground call, plus chat lines as `send_message` (they do not take the body). */
  readonly submitted: { readonly tool: ForegroundTool | "send_message" | "protect_region" | "unprotect_region"; readonly input: Readonly<Record<string, unknown>> }[] = [];
  readonly cancelled: string[] = [];
  private readonly actions = new Map<string, { tool: ForegroundTool; input: Readonly<Record<string, unknown>>; remaining: number; cancelled: boolean }>();
  private nextId = 1;

  get said(): string[] {
    return this.submitted.filter((call) => call.tool === "send_message").map((call) => String(call.input.message));
  }

  async status(): Promise<BotSnapshot> {
    return this.snapshot;
  }

  async say(message: string, to?: string, shout?: boolean): Promise<{ readonly status: "succeeded"; readonly error: null }> {
    this.submitted.push({ tool: "send_message", input: { message, ...(to !== undefined && { to }), ...(shout === true && to === undefined && { shout: true }) } });
    return { status: "succeeded", error: null };
  }

  /** Every `setDigStraightDown` call, in order. */
  readonly digSettings: boolean[] = [];

  async setDigStraightDown(allowed: boolean, revision: string): Promise<boolean> {
    this.digSettings.push(allowed);
    if (this.snapshot.policy === null || this.snapshot.policy.revision !== revision) return false;
    this.snapshot = { ...this.snapshot, policy: { revision: `${revision}+`, digStraightDown: allowed } };
    return true;
  }

  /** Every `setScaffoldBlocks` call, in order. */
  readonly scaffoldSettings: (readonly string[])[] = [];

  async setScaffoldBlocks(blocks: readonly string[], revision: string): Promise<boolean> {
    this.scaffoldSettings.push(blocks);
    if (this.snapshot.policy === null || this.snapshot.policy.revision !== revision) return false;
    this.snapshot = { ...this.snapshot, policy: { ...this.snapshot.policy, revision: `${revision}+`, scaffoldBlocks: blocks } };
    return true;
  }

  /** The values the fake's contract lets a tool's input property take, by "tool.property" (`toolEnum`); the runtime's own schema in real life. */
  toolEnums: Readonly<Record<string, readonly string[]>> = { "use_bucket.liquid": ["water", "lava"] };

  async toolEnum(tool: string, property: string): Promise<readonly string[]> {
    return this.toolEnums[`${tool}.${property}`] ?? [];
  }

  /** The `prefer` lists `craftingNeeds` was given, in order (the fake planner does not use them). */
  readonly preferences: (readonly string[])[] = [];
  /** Names that are no item id at all (`craftingNeeds` answers unknown). */
  notItems: ReadonlySet<string> = new Set();

  async craftingNeeds(items: readonly ItemCount[], prefer: readonly string[] = []): Promise<CraftingNeeds> {
    this.preferences.push(prefer);
    const unknown = items.filter(({ item }) => this.notItems.has(item)).map(({ item }) => item);
    if (unknown.length > 0) return { status: "unknown", missing: [], error: `[UNKNOWN_CRAFT_ITEMS] Minecraft has no registry items named: ${unknown.join(", ")}.` };
    if (items.some(({ item }) => this.unplannable.includes(item))) return { status: "planner_failed", missing: [] };
    if (items.some(({ item }) => this.recipes[item] === undefined)) return { status: "uncraftable", missing: [] };
    const leaves = new Map<string, number>();
    for (const { item, count } of items) this.leaves(item, count, leaves);
    const missing = [...leaves]
      .map(([item, count]) => ({ item, count: count - this.carried(item) }))
      .filter((entry) => entry.count > 0);
    const inputs = new Set<string>();
    for (const { item } of items) this.inputsOf(item, inputs);
    return { status: missing.length === 0 ? "ready" : "missing_materials", missing, inputs: [...inputs] };
  }

  async smeltingRecipes(items: readonly string[]): Promise<SmeltingKnowledge> {
    const recipes = Object.fromEntries(items.map((item) => [item, this.smelting[item] === undefined ? [] : [{ output: item, count: 1, inputs: this.smelting[item]! }]]));
    return { status: "known", recipes, fuels: this.fuels };
  }

  async blockSources(items: readonly string[]): Promise<Readonly<Record<string, readonly DropSource[]>>> {
    return Object.fromEntries(items.map((item) => [item, this.dropSources[item] ?? (this.notDropped.has(item) ? [] : [{ block: item, chance: 1, planted: false }])]));
  }

  /** Mobs each item drops from when killed (the runtime's entity loot tables); none unless listed. */
  mobDrops: Readonly<Record<string, readonly MobSource[]>> = {};

  async mobSources(items: readonly string[]): Promise<Readonly<Record<string, readonly MobSource[]>>> {
    return Object.fromEntries(items.map((item) => [item, this.mobDrops[item] ?? []]));
  }

  /** What each block drops: the items whose `dropSources` list it, else the block itself unless listed in `notDropped`. */
  async blockDrops(blocks: readonly string[]): Promise<Readonly<Record<string, readonly string[]>>> {
    return Object.fromEntries(blocks.map((block) => {
      const items = Object.entries(this.dropSources).filter(([, sources]) => sources.some((source) => source.block === block)).map(([item]) => item);
      return [block, items.length > 0 ? items : this.notDropped.has(block) ? [] : [block]];
    }));
  }

  /** The world's blocks for `blocksIn`/`findBlocks`, by `x,y,z`; unlisted cells are dirt up to `groundTop`, air above. */
  world = new Map<string, string>();
  /** The top of the fake world's flat ground: under the bot's feet by default, so a house site there is level. */
  groundTop = 63;
  /** Tool classes the fake reports per block name (others: none). */
  toolClasses: Readonly<Record<string, ToolClass>> = { dirt: "shovel", grass_block: "shovel", sand: "shovel", gravel: "shovel", stone: "pickaxe", cobblestone: "pickaxe", oak_log: "axe" };

  async blocksIn(min: Position, max: Position): Promise<BlockArea> {
    const blocks = new Map<string, string>();
    for (let x = min.x; x <= max.x; x += 1) for (let y = min.y; y <= max.y; y += 1) for (let z = min.z; z <= max.z; z += 1) {
      blocks.set(`${x},${y},${z}`, this.world.get(`${x},${y},${z}`) ?? (y <= this.groundTop ? "dirt" : "air"));
    }
    const kinds = Object.fromEntries([...new Set(blocks.values())].map((name): [string, BlockKind] => [name, this.kindOf(name)]));
    return { blocks, kinds };
  }

  /** Tools without which a block drops nothing, cheapest first, per block name (others: drops by hand). */
  harvestTools: Readonly<Record<string, readonly string[]>> = {
    stone: ["wooden_pickaxe", "stone_pickaxe", "iron_pickaxe"],
    cobblestone: ["wooden_pickaxe", "stone_pickaxe", "iron_pickaxe"],
    coal_ore: ["wooden_pickaxe", "stone_pickaxe", "iron_pickaxe"],
    iron_ore: ["stone_pickaxe", "iron_pickaxe"],
  };

  /** The game's block tags the fake reports per block name, on a `blockKinds` lookup only, like the runtime (others: none). */
  blockTags: Readonly<Record<string, readonly string[]>> = {
    dirt: ["dirt", "mineable/shovel"], grass_block: ["dirt", "mineable/shovel"], sand: ["mineable/shovel"], gravel: ["mineable/shovel"],
    stone: ["mineable/pickaxe"], cobblestone: ["mineable/pickaxe"], iron_ore: ["mineable/pickaxe"], coal_ore: ["mineable/pickaxe"],
    oak_log: ["logs", "mineable/axe"], spruce_log: ["logs", "mineable/axe"], oak_door: ["doors"], spruce_door: ["doors"],
    oak_planks: ["planks"], birch_planks: ["planks"], spruce_planks: ["planks"], birch_log: ["logs", "mineable/axe"],
  };

  /** Where blocks were seen, by name, as the bot data's frontier map would answer (others: never seen). */
  seen: Readonly<Record<string, SeenBlock>> = {};
  /** Further places for a block, after the one in {@link seen} (farther away, as the frontier map lists nearest first). */
  alsoSeen: Readonly<Record<string, readonly SeenBlock[]>> = {};

  /** How many blocks each successful `collect_block` reports broken, whatever it was asked for (default: the count asked). */
  collectBroken: ((input: Readonly<Record<string, unknown>>) => number) | null = null;

  /** A successful `navigate` moves the bot to its target (off by default: most tests keep the bot where it is). */
  walkOnNavigate = false;

  /** Surface water share of explored chunks, by "chunkX,chunkZ" (others: never explored). */
  water: Readonly<Record<string, number>> = {};

  async waterAlong(from: Position, to: Position): Promise<WaterShare | null> {
    const known = chunksAlong(from, to).map(([x, z]) => this.water[`${x},${z}`]).filter((share) => share !== undefined);
    return known.length === 0 ? null : { chunks: known.length, share: known.reduce((sum, share) => sum + share, 0) / known.length };
  }

  /** Chunks it has explored, by "chunkX,chunkZ", beside those in `water` (others: never seen). */
  explored: ReadonlySet<string> = new Set();

  async unseenAlong(from: Position, to: Position): Promise<number | null> {
    return firstUnseen(from, chunksAlong(from, to), new Set([...this.explored, ...Object.keys(this.water)]));
  }

  async nearestLand(from: Position): Promise<{ readonly x: number; readonly z: number } | null> {
    const land = Object.entries(this.water).filter(([, share]) => share < 0.5)
      .map(([key]) => { const [x, z] = key.split(",").map(Number) as [number, number]; return { x: x * 16 + 8, z: z * 16 + 8 }; })
      .sort((a, b) => Math.hypot(a.x - from.x, a.z - from.z) - Math.hypot(b.x - from.x, b.z - from.z));
    return land[0] ?? null;
  }

  async seenPlaces(block: string, from: Position, beyond: number, limit: number): Promise<readonly SeenBlock[]> {
    const seen = this.seen[block];
    const places = [...(seen === undefined ? [] : [seen]), ...(this.alsoSeen[block] ?? [])];
    return places.filter((place) => place.dimension === "overworld" && Math.hypot(place.x - from.x, place.z - from.z) > beyond).slice(0, limit);
  }

  async seenAt(block: string, from: Position, beyond: number): Promise<SeenBlock | null> {
    const seen = this.seen[block];
    if (seen === undefined) return null;
    return seen.dimension !== "overworld" || Math.hypot(seen.x - from.x, seen.z - from.z) > beyond ? seen : null;
  }

  /** Names that are no block (`blockKinds` leaves them out). */
  notBlocks: ReadonlySet<string> = new Set();

  async blockKinds(names: readonly string[]): Promise<Readonly<Record<string, BlockKind>>> {
    return Object.fromEntries(names.filter((name) => !this.notBlocks.has(name)).map((name) => [name, { ...this.kindOf(name), tags: this.blockTags[name] ?? [] }]));
  }

  private kindOf(name: string): BlockKind {
    const solid = !FAKE_NOT_SOLID.has(name);
    return { tool: this.toolClasses[name] ?? null, solid, fullCube: solid && !/_(stairs|slab|door|pane)$/u.test(name), harvest: this.harvestTools[name] ?? null };
  }

  async findBlocks(name: string, limit: number): Promise<readonly FoundBlock[]> {
    const at = this.snapshot.position;
    // The runtime's `logs` selector matches every wood's log.
    const matches = (block: string) => block === name || (name === "logs" && block.endsWith("_log"));
    return [...this.world].filter(([, block]) => matches(block))
      .map(([key, block]) => { const [x, y, z] = key.split(",").map(Number) as [number, number, number]; return { x, y, z, name: block }; })
      .sort((a, b) => Math.hypot(a.x - at.x, a.y - at.y, a.z - at.z) - Math.hypot(b.x - at.x, b.y - at.y, b.z - at.z))
      .slice(0, limit);
  }

  /** Protected areas, oldest first; a test may seed them to stand for an earlier run. Own areas are owned by "self". */
  areas: ProtectedArea[] = [];
  private nextRegionId = 1;

  async protectRegion(request: AreaRequest): Promise<AreaOutcome> {
    this.submitted.push({ tool: "protect_region", input: { ...request } });
    const owner = request.owner ?? "self";
    const same = (a: Position, b: Position) => a.x === b.x && a.y === b.y && a.z === b.z;
    const existing = this.areas.find((area) => area.owner === owner && same(area.min, request.min) && same(area.max, request.max));
    if (existing !== undefined) return { status: "succeeded", area: existing };
    const area = { regionId: this.nextRegionId++, label: request.label, owner, min: request.min, max: request.max };
    this.areas.push(area);
    return { status: "succeeded", area };
  }

  async unprotectRegion(regionId: number): Promise<{ readonly status: "succeeded" } | { readonly status: "failed"; readonly error: string }> {
    this.submitted.push({ tool: "unprotect_region", input: { region_id: regionId } });
    const index = this.areas.findIndex((area) => area.regionId === regionId);
    if (index === -1) return { status: "failed", error: `[REGION_NOT_FOUND] There is no protected region #${regionId}.` };
    this.areas.splice(index, 1);
    return { status: "succeeded" };
  }

  async protectedRegions(): Promise<readonly ProtectedArea[]> {
    return [...this.areas];
  }

  async readMessages(): Promise<readonly PlayerMessage[]> {
    const messages = this.inbox;
    this.inbox = [];
    return messages;
  }

  /** Notes saved with `note_save`, oldest first; a test may seed them to stand for an earlier run. */
  notes: { readonly note: string; readonly context: string }[] = [];
  /** Every SQL statement asked of `queryBotData`. */
  readonly queries: string[] = [];

  /** Answers any query with every saved note as `[note_id, context]`, newest first (the SQL is not run). */
  async queryBotData(sql: string): Promise<readonly (readonly (string | number | null)[])[]> {
    this.queries.push(sql);
    return this.notes.map((note, index) => [index + 1, note.context]).reverse();
  }

  async submit(tool: ForegroundTool, input: Readonly<Record<string, unknown>>): Promise<ForegroundState> {
    if (this.refuseNext !== null) {
      const refusal = this.refuseNext;
      this.refuseNext = null;
      return refusal;
    }
    this.submitted.push({ tool, input });
    const thrown = this.throwNext[tool];
    if (thrown !== undefined) {
      delete this.throwNext[tool];
      throw new Error(thrown);
    }
    if (tool === "note_save") this.notes.push({ note: String(input.note), context: String(input.context) });
    const actionId = `action-${this.nextId++}`;
    this.actions.set(actionId, { tool, input, remaining: this.durations[tool] ?? 0, cancelled: false });
    return this.step(actionId);
  }

  async wait(actionId: string): Promise<ForegroundState> {
    // Yield to timers like a real network round trip, so pending loops never starve the test.
    await sleep(1);
    return this.step(actionId);
  }

  async cancel(actionId: string): Promise<void> {
    this.cancelled.push(actionId);
    const action = this.actions.get(actionId);
    if (action !== undefined) action.cancelled = true;
  }

  async close(): Promise<void> {}

  private carried(item: string): number {
    return this.snapshot.inventory.filter((stack) => stack.name === item).reduce((sum, stack) => sum + stack.count, 0);
  }

  /** Every item the recipe tree of `item` takes, the intermediate ones included. */
  private inputsOf(item: string, into: Set<string>): void {
    for (const need of this.recipes[item]?.needs ?? []) {
      into.add(need.item);
      this.inputsOf(need.item, into);
    }
  }

  private leaves(item: string, count: number, into: Map<string, number>): void {
    const recipe = this.recipes[item];
    if (recipe === undefined) {
      into.set(item, (into.get(item) ?? 0) + count);
      return;
    }
    const applications = Math.ceil(count / recipe.makes);
    for (const need of recipe.needs) this.leaves(need.item, need.count * applications, into);
  }

  /** Adds (or with a negative delta removes) carried items. */
  addItem(item: string, delta: number): void {
    const total = this.carried(item) + delta;
    const others = this.snapshot.inventory.filter((stack) => stack.name !== item);
    this.snapshot = { ...this.snapshot, inventory: total > 0 ? [...others, { name: item, count: total }] : others };
  }

  /** A `tend_crops` result for the plot: every cell but the middle planted (src/actions/tend-crops/contract.ts). */
  /** Replaces the `tend_crops` result the fake settles with, when a test needs a particular plot. */
  tendAfter: Readonly<Record<string, unknown>> | null = null;
  /** Cells `tend_crops` leaves as they were, by reason: the fake then settles it as partial ([TEND_INCOMPLETE]). */
  tendSkipped: Readonly<Record<string, readonly { x: number; z: number }[]>> | null = null;
  /** The soils `tend_crops` reports tilled, by block name and cells. */
  tendTilledSoil: Readonly<Record<string, number>> = {};
  /** The blocks a hoe was used on without changing them, by block name and cells (`untillable`). */
  tendUntillable: Readonly<Record<string, readonly { x: number; z: number }[]>> = {};
  /** How such a tend settles: partial, or failed when no cell changed. */
  tendSkippedStatus: "partial" | "failed" = "partial";

  private collectResult(input: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
    const requested = Number(input.count ?? 1);
    return { status: "succeeded", collected: { requested, gained: requested, gainedByItem: {}, blocksBroken: this.collectBroken?.(input) ?? requested, brokenAt: [] } };
  }

  private tendResult(input: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
    const skipped = this.tendSkipped ?? {};
    if (this.tendAfter !== null) return { tended: { after: this.tendAfter, skipped, tilledSoil: this.tendTilledSoil, untillable: this.tendUntillable } };
    const cells = (Math.abs(Number(input.x2) - Number(input.x1)) + 1) * (Math.abs(Number(input.z2) - Number(input.z1)) + 1) - 1;
    return { tended: { after: { crops: { "wheat age 0": cells }, emptyFarmland: 0, dryFarmland: 0, water: 1 }, skipped, tilledSoil: this.tendTilledSoil, untillable: this.tendUntillable } };
  }

  /** What a successful action does to the inventory (leaves only: the fake crafts in one go). */
  private applyEffects(tool: ForegroundTool, input: Readonly<Record<string, unknown>>): void {
    if (!this.simulateInventory) return;
    if (tool === "collect_block") {
      const block = String(input.block_name);
      // An exact cell is one block, dug out of the world.
      if (input.x !== undefined) this.world.set(`${String(input.x)},${String(input.y)},${String(input.z)}`, "air");
      this.addItem(FAKE_DROPS[block] ?? block, Number(input.count ?? 1));
    }
    if (tool === "collect_mob_drop") this.addItem(String(input.drop_name), Number(input.count ?? 1));
    if (tool === "use_bucket") {
      const full = `${String(input.liquid ?? "water")}_bucket`;
      const [from, to] = input.action === "fill" ? ["bucket", full] : [full, "bucket"];
      this.addItem(from, -1);
      this.addItem(to, 1);
      if (input.action === "pour") this.world.set(`${String(input.x)},${String(input.y)},${String(input.z)}`, "water");
    }
    if (tool === "tend_crops" && input.plant !== undefined) {
      const cells = (Math.abs(Number(input.x2) - Number(input.x1)) + 1) * (Math.abs(Number(input.z2) - Number(input.z1)) + 1) - 1;
      this.addItem(String(input.plant), -Math.min(cells, this.carried(String(input.plant))));
    }
    if (tool === "smelt_item") {
      const count = Number(input.count);
      const fuel = String(input.fuel_item_name);
      const input_ = String(input.item_name);
      const output = Object.entries(this.smelting).find(([, inputs]) => inputs.includes(input_))?.[0];
      if (output === undefined) throw new Error(`the fake cannot smelt ${input_}`);
      this.addItem(input_, -count);
      this.addItem(fuel, -Math.ceil(count / (this.fuels[fuel] ?? 1)));
      this.addItem(output, count);
    }
    if (tool === "craft_item") {
      for (const { item_name: item, count } of input.items as { item_name: string; count: number }[]) {
        const leaves = new Map<string, number>();
        this.leaves(item, count, leaves);
        for (const [leaf, used] of leaves) this.addItem(leaf, -used);
        this.addItem(item, count);
      }
    }
  }

  private step(actionId: string): ForegroundState {
    const action = this.actions.get(actionId);
    if (action === undefined) return { state: "settled", actionId, status: "succeeded", error: null };
    if (action.cancelled) return { state: "settled", actionId, status: "cancelled", error: "cancelled by caller" };
    if (action.remaining > 0) {
      action.remaining -= 1;
      return { state: "pending", actionId };
    }
    if (action.tool === "drop_item" && this.dropOutcomes.length > 0) {
      const outcome = this.dropOutcomes.shift()!;
      outcome.effect?.();
      return { state: "settled", actionId, status: outcome.status, error: outcome.error, result: { status: outcome.status, drop: { dropped: outcome.dropped } } };
    }
    const once = this.failNext[action.tool];
    if (once !== undefined) {
      delete this.failNext[action.tool];
      once.effect?.();
      return { state: "settled", actionId, status: "failed", error: once.error, ...(once.result !== undefined && { result: once.result }) };
    }
    const failure = this.failures[action.tool];
    if (failure !== undefined) {
      const result = this.failureResults[action.tool];
      return { state: "settled", actionId, status: "failed", error: failure, ...(result !== undefined && { result }) };
    }
    this.applyEffects(action.tool, action.input);
    if (action.tool === "navigate" && this.walkOnNavigate) {
      // It reaches the ground asked for, at the height it stands.
      this.snapshot = { ...this.snapshot, position: { x: Number(action.input.x), y: this.snapshot.position.y, z: Number(action.input.z) } };
    }
    const result = action.tool === "tend_crops" ? this.tendResult(action.input) : action.tool === "collect_block" ? this.collectResult(action.input) : undefined;
    if (action.tool === "tend_crops" && this.tendSkipped !== null) {
      const cells = Object.values(this.tendSkipped).reduce((sum, list) => sum + list.length, 0);
      return { state: "settled", actionId, status: this.tendSkippedStatus, error: `[TEND_INCOMPLETE] ${cells} cells could not be farmed; see skipped.`, result };
    }
    return { state: "settled", actionId, status: "succeeded", error: null, ...(result !== undefined && { result }) };
  }
}

export function testPersona(overrides: Partial<Persona> = {}): Persona {
  return {
    id: "ayla",
    username: "Ayla",
    displayName: "Ayla",
    stance: "companion",
    description: "A test companion.",
    traits: [],
    voice: "Plain.",
    listensTo: [],
    authority: ["*"],
    // Tests never wait on pacing: 600 goal calls a minute is one every 100 ms. No progress lines unless a test asks.
    settings: { goalCallsPerMinute: 600, maxStepsPerObjective: 40, maxSameStepInARow: 3, maxSkillFailuresInARow: 6, restAfterStopSeconds: 0, narrateEverySeconds: 3_600, chatBurstMs: 0, digStraightDown: false, shelterAtNight: true, feelingMultipliers: { loves: 2, likes: 1.5, neutral: 1, dislikes: 0.6, hates: 0.3 } },
    models: {},
    ...overrides,
  };
}

/** A chat model replying from a script, recording what it was sent. */
export class ScriptedModel implements ChatModel {
  readonly requests: (readonly ChatTurn[])[] = [];
  constructor(readonly name: string, private readonly replies: string[] = []) {}

  /** Queue replies, as objects (sent as JSON) or raw text. */
  reply(...replies: (string | object)[]): this {
    this.replies.push(...replies.map((reply) => (typeof reply === "string" ? reply : JSON.stringify(reply))));
    return this;
  }

  private readonly holds: Promise<void>[] = [];

  /** The next call waits (after it is recorded) until the returned function is called: a slow model. */
  hold(): () => void {
    let release!: () => void;
    this.holds.push(new Promise((resolve) => { release = resolve; }));
    return release;
  }

  async complete(turns: readonly ChatTurn[]): Promise<ChatReply> {
    this.requests.push([...turns]);
    const hold = this.holds.shift();
    if (hold !== undefined) await hold;
    const reply = this.replies.shift();
    if (reply === undefined) throw new Error(`${this.name}: no scripted reply left`);
    return { text: reply, promptTokens: null, contextTokens: null };
  }
}

/** One scripted model per tier, plus the mind using them. */
export function scriptedMind(localizedChat?: LocalizedChat) {
  const models = { chat: new ScriptedModel("chat"), action: new ScriptedModel("action"), planner: new ScriptedModel("planner") };
  return { ...models, mind: new LlmMind(models, undefined, localizedChat) };
}

/** Polls until the condition holds; fails the test after `timeoutMs`. */
export async function until(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not reached in time");
    await sleep(5);
  }
}
