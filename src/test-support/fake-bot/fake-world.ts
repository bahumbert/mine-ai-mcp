/** The fake bot's world: named cells as real Prismarine blocks of one version, so shapes and states are the game's. */
import { createRequire } from "node:module";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { blockClass, type MineflayerBlock } from "../../navigation/mineflayer/world.js";
import { cellKey } from "../../utils/index.js";

/** A block by name, by name with state properties, by state id, or `"void"`: a cell in a chunk the bot has not loaded. */
export type FakeCell =
  | string
  | number
  | { readonly name: string; readonly properties: Readonly<Record<string, string | number | boolean>> };

export interface FakeWorldOptions {
  /** `"x,y,z"` to the block there; every other cell is air, or stone at and below `groundY`. */
  readonly cells?: Readonly<Record<string, FakeCell>>;
  /** Stone at this level and below; omitted or null for open air. */
  readonly groundY?: number | null;
  /** Called with every cell `blockAt` reads, to assert on a rule's cost. */
  readonly onRead?: (cell: Vec3) => void;
}

/** Whatever hears the world's block updates: the bot, as Mineflayer forwards them to it. */
export interface BlockUpdateSink {
  emit(event: "blockUpdate" | "blockUpdate:(x, y, z)", before: MineflayerBlock | null, after: MineflayerBlock | null): boolean;
}

export type FakeRaycastHit = MineflayerBlock & { face: number; intersect: Vec3 };

export interface FakeWorld {
  readonly version: string;
  readonly registry: Bot["registry"];
  /** `bot.blockAt`: a block placed at the cell, or null when the cell is `"void"`. */
  blockAt(cell: Vec3): MineflayerBlock | null;
  /** `bot.world.getBlockStateId`: the cell's state id; 0 for `"void"`, as Prismarine answers an unloaded column. */
  getBlockStateId(cell: Vec3): number;
  /** Change a cell and emit `blockUpdate` and `blockUpdate:(x, y, z)` with the old and the new block. */
  setCell(cell: Vec3, block: FakeCell): void;
  /** `bot.world.raycast`: the first block with a collision shape on the ray (fluids have none), with face and point. */
  raycast(origin: Vec3, direction: Vec3, maxDistance: number): FakeRaycastHit | null;
  /** Emit every block update on `sink` too, as Mineflayer forwards the world's events to the bot. */
  forwardTo(sink: BlockUpdateSink): void;
}

const require = createRequire(import.meta.url);
const VOID = "void";

/** prismarine-world's ray walk (`iterators.js`), the one `bot.world.raycast` steps with; it ships no typings. */
interface RaycastIterator {
  next(): { x: number; y: number; z: number } | null;
  intersect(shapes: MineflayerBlock["shapes"], offset: Vec3): { face: number; pos: Vec3 } | null;
}
const { RaycastIterator } = require("prismarine-world/src/iterators.js") as {
  RaycastIterator: new (origin: Vec3, direction: Vec3, maxDistance: number) => RaycastIterator;
};

/** Mineflayer's per-cell block event (`blockUpdate:(x, y, z)`), which its typings name by that one literal. */
export function blockUpdateEventOf(cell: Vec3): "blockUpdate:(x, y, z)" {
  return `blockUpdate:${cell.floored()}` as "blockUpdate:(x, y, z)";
}

/** The state id a cell stands for, or `VOID`; throws naming a block or property the version does not have. */
function stateIdOf(registry: Bot["registry"], Block: ReturnType<typeof blockClass>, cell: FakeCell): number | typeof VOID {
  if (cell === VOID) return VOID;
  if (typeof cell === "number") {
    if (registry.blocksByStateId[cell] === undefined) throw new Error(`unknown block state id ${cell} in ${registry.version.minecraftVersion}`);
    return cell;
  }
  const name = typeof cell === "string" ? cell : cell.name;
  const registered = registry.blocksByName[name];
  if (!registered) throw new Error(`unknown block ${name} in ${registry.version.minecraftVersion}`);
  if (typeof cell === "string") return registered.defaultState!;
  const properties = Object.fromEntries(Object.entries(cell.properties).map(([key, value]) => [key, String(value)]));
  const known = new Set((registered.states ?? []).map((state) => state.name));
  for (const key of Object.keys(properties)) if (!known.has(key)) throw new Error(`${name} has no state ${key}`);
  return Block.fromProperties(registered.id, properties, 0).stateId;
}

export function createFakeWorld(version: string, options: FakeWorldOptions = {}): FakeWorld {
  // Mineflayer's own registry (`loader.js`): minecraft-data plus Prismarine's indexes.
  const registry = (require("prismarine-registry") as (version: string) => Bot["registry"])(version);
  const Block = blockClass({ registry } as Parameters<typeof blockClass>[0]);
  const groundY = options.groundY ?? null;
  const stone = registry.blocksByName.stone!.defaultState!;
  const air = registry.blocksByName.air!.defaultState!;
  const cells = new Map<string, number | typeof VOID>();
  for (const [key, cell] of Object.entries(options.cells ?? {})) cells.set(key, stateIdOf(registry, Block, cell));
  const sinks = new Set<BlockUpdateSink>();

  const stateAt = (cell: Vec3) => cells.get(cellKey(cell.floored())) ?? (groundY !== null && Math.floor(cell.y) <= groundY ? stone : air);
  const placed = (stateId: number, cell: Vec3) => {
    const block = Block.fromStateId(stateId, 0);
    block.position = cell.floored();
    return block;
  };
  const read = (cell: Vec3) => {
    const stateId = stateAt(cell);
    return stateId === VOID ? null : placed(stateId, cell);
  };
  return {
    version,
    registry,
    blockAt(cell) {
      options.onRead?.(cell);
      return read(cell);
    },
    getBlockStateId(cell) {
      const stateId = stateAt(cell);
      return stateId === VOID ? 0 : stateId;
    },
    setCell(cell, block) {
      const before = read(cell);
      cells.set(cellKey(cell.floored()), stateIdOf(registry, Block, block));
      const after = read(cell);
      for (const sink of sinks) {
        sink.emit("blockUpdate", before, after);
        sink.emit(blockUpdateEventOf(cell), before, after);
      }
    },
    raycast(origin, direction, maxDistance) {
      // prismarine-world `raycast` (`worldsync.js:40-60`): each cell on the walk is met only where its shapes are.
      const iterator = new RaycastIterator(origin, direction, maxDistance);
      for (let cell: { x: number; y: number; z: number } | null = origin; cell !== null; cell = iterator.next()) {
        const position = new Vec3(cell.x, cell.y, cell.z);
        const block = read(position);
        const hit = block === null ? null : iterator.intersect(block.shapes, position);
        if (hit !== null) return Object.assign(block!, { face: hit.face, intersect: hit.pos });
      }
      return null;
    },
    forwardTo: (sink) => void sinks.add(sink),
  };
}

