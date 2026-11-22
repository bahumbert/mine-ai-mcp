/**
 * The server's lava flowing, as it answered contract checks `lava-over-hole` and `lava-over-passable` (Mine Labs 1.21.4,
 * 2026-10-24, and `lava-beside-head`, 2026-11-08; facts `fire-lava-escape.md` "Flowing lava over a hole", "Lava over sugar cane and
 * a structure void" and "Lava beside the head cell over a hole"): every step takes 30 server ticks from the tick the lava cell appeared.
 * Over a floor, a source or a flowing cell with a level left (0, 2, 4: not 6) fills each open neighbour (air, on the four sides) with a
 * flowing cell two levels higher, and a falling column fills it with a flowing level 2. Over air, lava of any level pours a falling
 * column (level 8) and fills no cell beside it, except a source: its second turn, once its column stands, fills the air beside it with
 * a level 2. A falling column goes on down a cell every 30 ticks. Over lava (a column or a source), nothing happens, except a flowing
 * level 2 under lava: it becomes a falling column (the only flowing level measured under lava). Lava over sugar cane or a structure
 * void does not pour into them: both stay, and the lava stays where it is. Lava set in the cell above a nether portal block (the
 * frame's top) breaks the whole portal at once.
 * Not modelled, because not measured: the cells beside a source over sugar cane or a structure void, unfed lava drying up, lava meeting water, the Nether's
 * faster flow, anything but air being flowed into, lava updating when a block beside, around or under it changes (the cane under lava broken after the lava's turn does not make it pour), lava entering a portal from its
 * side or over a portal that stays.
 */
import type { Vec3 } from "vec3";
import { cellKey } from "../../utils/index.js";
import { onServerTick } from "./fake-bot-server-ticks.js";
import type { FakeServer } from "./fake-server.js";
import type { BlockUpdateSink, FakeWorld } from "./fake-world.js";

/** Ticks from a lava cell's appearing to its flowing on. */
const LAVA_FLOW_TICKS = 30;
/** The level of lava beside a source or a flowing cell, in the overworld: two more than it. */
const LEVEL_STEP = 2;
const SOURCE_LEVEL = 0;
const FALLING_LEVEL = 8;
const AIR_BLOCKS: ReadonlySet<string> = new Set(["air", "cave_air", "void_air"]);
const SIDES: readonly (readonly [number, number])[] = [[-1, 0], [1, 0], [0, -1], [0, 1]];

export interface LavaFlowParts {
  readonly server: FakeServer;
  readonly world: FakeWorld;
}

/** The lava level at `cell`, or null when it holds no lava. */
function lavaLevelAt(world: FakeWorld, cell: Vec3): number | null {
  const block = world.blockAt(cell);
  return block?.name === "lava" ? Number(block.getProperties().level) : null;
}

const isAirAt = (world: FakeWorld, cell: Vec3) => AIR_BLOCKS.has(world.blockAt(cell)?.name ?? "");

/** Blocks lava over them does not pour into (contract check `lava-over-passable`). */
/** The production list is `LAVA_CANNOT_ENTER` in `navigation/mineflayer/world.ts`; the fake keeps its own copy, from the same measure. */
const LAVA_CANNOT_ENTER: ReadonlySet<string> = new Set(["sugar_cane", "structure_void"]);

/** Fill the air cells beside `cell` with flowing lava of `level`. */
function spreadSideways(world: FakeWorld, cell: Vec3, level: number): void {
  for (const [dx, dz] of SIDES) {
    const beside = cell.offset(dx, 0, dz);
    if (isAirAt(world, beside)) world.setCell(beside, { name: "lava", properties: { level } });
  }
}

/**
 * The lava at `cell` flows on once. Over air it pours a falling column (any level) and a source, whose column then stands under it,
 * spreads sideways at its next turn (returns true: flow again). A flowing level 2 under lava becomes a falling column (contract check
 * `lava-beside-head`: the head cell's level 2 over the feet cell's level 2; no other flowing level under lava was measured). Over a floor a
 * source or a flowing cell with a level left fills the air beside it two levels higher; a falling column fills it with a flowing level 2.
 */
function flowOn(world: FakeWorld, cell: Vec3): boolean {
  const level = lavaLevelAt(world, cell);
  if (level === null) return false;
  const below = cell.offset(0, -1, 0);
  const belowLevel = lavaLevelAt(world, below);
  if (belowLevel !== null) {
    if (belowLevel === LEVEL_STEP) world.setCell(below, { name: "lava", properties: { level: FALLING_LEVEL } });
    else if (level === SOURCE_LEVEL && belowLevel === FALLING_LEVEL) spreadSideways(world, cell, LEVEL_STEP);
    return false;
  }
  if (isAirAt(world, below)) {
    world.setCell(below, { name: "lava", properties: { level: FALLING_LEVEL } });
    return level === SOURCE_LEVEL;
  }
  if (LAVA_CANNOT_ENTER.has(world.blockAt(below)?.name ?? "")) return false;
  if (level === FALLING_LEVEL) spreadSideways(world, cell, LEVEL_STEP);
  else if (level + LEVEL_STEP < FALLING_LEVEL) spreadSideways(world, cell, level + LEVEL_STEP);
  return false;
}

/** The cells of the portal that `portalBlock` belongs to: nether portal blocks joined along the plane of its axis. */
function portalOf(world: FakeWorld, portalBlock: Vec3): Vec3[] {
  const axis = world.blockAt(portalBlock)?.getProperties().axis;
  const [alongX, alongZ] = axis === "z" ? [0, 1] : [1, 0];
  const steps = [[alongX, 0, alongZ], [-alongX, 0, -alongZ], [0, 1, 0], [0, -1, 0]] as const;
  const seen = new Map<string, Vec3>([[cellKey(portalBlock), portalBlock]]);
  for (const cell of seen.values())
    for (const [dx, dy, dz] of steps) {
      const next = cell.offset(dx, dy, dz);
      if (!seen.has(cellKey(next)) && world.blockAt(next)?.name === "nether_portal") seen.set(cellKey(next), next);
    }
  return [...seen.values()];
}

/** Lava set in the cell above a portal block replaced the frame's top: the portal breaks, all of it, at once. */
function breakPortalUnder(world: FakeWorld, lavaCell: Vec3): void {
  const top = lavaCell.offset(0, -1, 0);
  if (world.blockAt(top)?.name !== "nether_portal") return;
  for (const cell of portalOf(world, top)) world.setCell(cell, "air");
}

/** Let lava that appears in the world flow on, tick by tick of the running server. */
export function attachFakeLavaFlow({ server, world }: LavaFlowParts): void {
  let tick = 0;
  /** The tick each lava cell flows at, by cell; a cell whose lava is gone loses its turn. */
  const due = new Map<string, { readonly cell: Vec3; readonly tick: number }>();
  const sink: BlockUpdateSink = {
    emit(event: string, _before: unknown, after?: unknown) {
      if (event !== "blockUpdate") return true;
      const block = after as { readonly name: string; readonly position: Vec3 } | null;
      if (block === null) return true;
      const key = cellKey(block.position);
      if (block.name !== "lava") due.delete(key);
      else if (!due.has(key)) {
        due.set(key, { cell: block.position, tick: tick + LAVA_FLOW_TICKS });
        breakPortalUnder(world, block.position);
      }
      return true;
    },
  };
  world.forwardTo(sink);
  onServerTick(server, () => {
    tick += 1;
    for (const [key, entry] of [...due]) {
      if (entry.tick > tick) continue;
      due.delete(key);
      if (flowOn(world, entry.cell)) due.set(key, { cell: entry.cell, tick: tick + LAVA_FLOW_TICKS });
    }
  });
}
