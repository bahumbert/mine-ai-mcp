/**
 * A world for building in without a server: a stone floor under air, a bot
 * that carries what it is told, and physical effects that edit the map. Every
 * stall the build process has had was a disagreement between what the world
 * offered and what the loop did about it, which a fake answers in a
 * millisecond rather than a thirty-second fixture.
 */
import minecraftData from "minecraft-data";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { type MineflayerBlock, blockClass } from "../navigation/mineflayer/world.js";
import type { BuildRequest } from "../navigation/processes/building/build-process.js";
import { CarriedCounts } from "./carried-counts.js";
import { type FakeCell, type FakeHarness, type FakeWorld, createFakeBot } from "./fake-bot/index.js";
import { observation } from "./navigation.js";

const STRUCTURE_VERSION = "1.21.4";

const key = (position: { x: number; y: number; z: number }) => `${position.x},${position.y},${position.z}`;

export interface StructureWorldOptions {
  readonly feet?: Vec3;
  readonly carried?: Record<string, number>;
  /** Cells beyond this many blocks from the bot read as unloaded. */
  readonly loadedRadius?: number;
  /** Build on the shared fake (see `structureWorld`); off, on the scene's own blocks. */
  readonly onHarness?: boolean;
}

/** A block of the scene as its physics and tests read it. */
type StructureBlock = Pick<MineflayerBlock, "name" | "position"> & { readonly boundingBox: string; getProperties(): Record<string, unknown> };

const DEFAULT_CARRIED = { cobblestone: 64, obsidian: 14 };

export type StructurePhysics = Pick<BuildRequest, "movements" | "route" | "breakInPlace" | "canSeeDig" | "place">;

/** The cells of the floor: stone at y 63 from x -6 to 40 and z -6 to 6; air around and under it. */
function floorCells(): Record<string, FakeCell> {
  const cells: Record<string, FakeCell> = {};
  for (let x = -6; x <= 40; x += 1) for (let z = -6; z <= 6; z += 1) cells[`${x},63,${z}`] = "stone";
  return cells;
}

/**
 * The block's states once placed: its default state with the placement states it has (an oriented block's facing, a
 * log's axis, a stair's half, a slab's type) on top, as the server places it; a slab stays dry, never waterlogged.
 */
function placedStates(bot: Pick<Bot, "registry">, name: string, states: Record<string, unknown>): Record<string, string | number | boolean> {
  const registered = bot.registry.blocksByName[name];
  if (registered === undefined) throw new Error(`unknown block ${name}`);
  const defaults = blockClass(bot).fromStateId(registered.defaultState!, 0).getProperties() as Record<string, string | number | boolean>;
  const given = Object.entries(states).filter(([state]) => state in defaults) as [string, string | number | boolean][];
  return { ...defaults, ...Object.fromEntries(given) };
}

/** The world's blocks by `"x,y,z"`, read from the harness world at each `get` (a fresh block, as `blockAt` gives). */
class WorldBlocks extends Map<string, MineflayerBlock> {
  readonly #world: FakeWorld;
  constructor(world: FakeWorld) {
    super();
    this.#world = world;
  }
  override get(cell: string): MineflayerBlock | undefined {
    const [x, y, z] = cell.split(",").map(Number);
    return this.#world.blockAt(new Vec3(x!, y!, z!)) ?? undefined;
  }
  override has(cell: string): boolean {
    return this.get(cell) !== undefined;
  }
}

/** What a structure's scene offers its physics: the bot, its blocks by `"x,y,z"`, and the two changes the physics makes. */
interface StructureScene {
  readonly bot: Bot;
  readonly blocks: Map<string, StructureBlock>;
  readonly harness?: FakeHarness;
  /** Change a cell; returns `blocks`. */
  put(at: Vec3, name: string, properties?: Record<string, unknown>): Map<string, StructureBlock>;
  /** One of the item left the inventory (a placement). */
  useOne(itemName: string): void;
}

/** The scene on the shared fake: the floor's cells in its world, the carried stacks in its window. */
function sceneOnHarness(options: StructureWorldOptions, position: Vec3): StructureScene {
  const harness = createFakeBot({
    version: STRUCTURE_VERSION,
    position,
    groundY: null,
    cells: floorCells(),
    carried: options.carried ?? DEFAULT_CARRIED,
    overrides: {
      blockAt: (at: Vec3) => {
        if (options.loadedRadius !== undefined && at.distanceTo(harness.bot.entity.position) > options.loadedRadius) return null;
        return harness.world.blockAt(at);
      },
    },
  });
  const { bot, world } = harness;
  const blocks = new WorldBlocks(world);
  const counts = new CarriedCounts(harness.inventory, bot.registry);
  return {
    bot,
    blocks,
    harness,
    put(at, name, properties = {}) {
      world.setCell(at, { name, properties: placedStates(bot, name, properties) });
      return blocks;
    },
    useOne(itemName) {
      const item = bot.registry.itemsByName[itemName]!.id;
      counts.set(item, (counts.get(item) ?? 0) - 1);
    },
  };
}

/**
 * Kept for unmigrated importers (build-process incl. its in-place `stateId` edit at :426, build-structure,
 * action-runner-resume-build): the scene on its own blocks, with a bounding box and exactly the states they were put
 * with (a slab put with `type` reads no `waterlogged`, as `build-process.test.ts:369` asserts).
 */
function sceneOnOwnBlocks(options: StructureWorldOptions, position: Vec3): StructureScene {
  const blocks = new Map<string, StructureBlock>();
  const put = (at: Vec3, name: string, properties: Record<string, unknown> = {}) =>
    blocks.set(key(at), { name, boundingBox: name === "air" ? "empty" : "block", position: at, getProperties: () => properties });
  for (const [cell, name] of Object.entries(floorCells())) {
    const [x, y, z] = cell.split(",").map(Number);
    put(new Vec3(x!, y!, z!), String(name));
  }
  const carried = new Map(Object.entries(options.carried ?? DEFAULT_CARRIED));
  const registry = minecraftData(STRUCTURE_VERSION);
  const bot = {
    game: { dimension: "overworld" },
    registry, version: STRUCTURE_VERSION,
    entity: { position, height: 1.8 },
    inventory: {
      items: () => [...carried].filter(([, count]) => count > 0).map(([name, count]) => ({ name, count })),
    },
    blockAt: (at: Vec3) => {
      if (options.loadedRadius !== undefined && at.distanceTo(bot.entity.position) > options.loadedRadius) return null;
      return blocks.get(key(at)) ?? { name: "air", boundingBox: "empty" as const, position: at, getProperties: () => ({}) };
    },
  } as unknown as Bot;
  return { bot, blocks, put, useOne: (itemName) => void carried.set(itemName, (carried.get(itemName) ?? 0) - 1) };
}

/**
 * A stone floor at y 63 under air, a bot standing at `feet`, and the log of what the physics did. With `onHarness` the
 * bot is the shared fake's (`fake-bot/`, returned as `harness`): real blocks of the version, placed in their default
 * state with the placement states on top.
 */
export function structureWorld(options: StructureWorldOptions = {}) {
  const position = (options.feet ?? new Vec3(0, 64, 0)).offset(0.5, 0, 0.5);
  const { bot, blocks, put, useOne, harness } = options.onHarness ? sceneOnHarness(options, position) : sceneOnOwnBlocks(options, position);
  const placements: string[] = [];
  /** The direction the bot looked for each placement that asked for one. */
  const looks: string[] = [];
  const routes: string[] = [];
  const protectedSets: ReadonlySet<number>[] = [];
  const physics: StructurePhysics = {
    canSeeDig: () => true,
    movements: (protectedCells) => {
      protectedSets.push(protectedCells);
      return {} as never;
    },
    route: async ({ goal, onArrival }) => {
      // Arrive next to whatever the goal asks for first: two blocks toward the
      // origin side of it. Then let the process work there and, if it asks to
      // continue, walk on to the next thing the revised goal names.
      for (let legs = 0; legs < 64; legs += 1) {
        const resolved = goal.resolve(observation());
        if (resolved.kind !== "active") return { status: "stopped", reason: resolved.observation, elapsedMs: 0 };
        const target = /(-?\d+),(-?\d+),(-?\d+)/.exec(resolved.revision)!;
        routes.push(resolved.revision);
        bot.entity.position = new Vec3(Number(target[1]) - 2 + 0.5, 64, Number(target[3]) + 0.5);
        const decision = onArrival ? await onArrival({ signal: undefined } as never) : { kind: "completed" };
        if (decision.kind === "completed") return { status: "completed", elapsedMs: 0 };
      }
      return { status: "stopped", reason: "the fake route ran out of legs", elapsedMs: 0 };
    },
    breakInPlace: async ({ position }) => {
      put(new Vec3(position.x, position.y, position.z), "air");
      return { status: "broken" };
    },
    place: async (placement) => {
      const cell = placement.expectedCells[0];
      placements.push(key(cell));
      // Minecraft gives an oriented block the placing player's horizontal facing.
      const look = placement.lookDirection;
      const facing = look === undefined ? undefined : look.x > 0 ? "east" : look.x < 0 ? "west" : look.z > 0 ? "south" : "north";
      if (facing !== undefined) looks.push(facing);
      // Vanilla's other placement states (ADR-013): a log lies along the clicked face's axis; stairs and slabs take
      // the top half against the underside of the block above, or a side face clicked above its middle.
      const name = placement.item.name;
      const face = placement.face;
      const axis = face.x !== 0 ? "x" : face.y !== 0 ? "y" : "z";
      const half = face.y < 0 || (face.y === 0 && placement.half === "top") ? "top" : "bottom";
      const states = {
        ...(facing !== undefined && { facing }),
        ...(name.endsWith("_log") && { axis }),
        ...(name.endsWith("_stairs") && { half }),
        ...(name.endsWith("_slab") && { type: half }),
      };
      put(new Vec3(cell.x, cell.y, cell.z), name, states);
      useOne(placement.item.name);
      return { kind: "placed", block: blocks.get(key(cell)) as never };
    },
  };
  return { bot, blocks, put, physics, placements, looks, routes, protectedSets, harness };
}
