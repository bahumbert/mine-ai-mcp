/**
 * The server's lava flowing, as it answered contract checks `lava-over-hole` and `lava-over-passable` (Mine Labs 1.21.4,
 * 2026-10-24; facts `fire-lava-escape.md` "Flowing lava over a hole" and "Lava over sugar cane and a structure void"): every step
 * takes 30 server ticks from the tick the lava cell appeared. A lava source or a flowing level 2 with a floor under it fills each
 * open neighbour (air, on the four sides) with a flowing cell two levels higher (2, then 4). Lava with air under it pours into the
 * air as a falling column (level 8) and fills no cell beside it, and a falling column goes on down a cell every 30 ticks; with
 * lava under it, nothing happens. Lava over sugar cane or a structure void does not pour into them: both stay, and the lava stays
 * where it is. Lava set in the cell above a nether portal block (the frame's top) breaks the whole portal at once.
 * Not modelled, because not measured: a cell of level 4 and more spreading, a falling column spreading where it lands, the cells
 * beside a source over a hole or over sugar cane or a structure void, unfed lava drying up, lava meeting water, the Nether's
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

/** The lava at `cell` flows on once: over air it pours a falling column; a source or a level 2 over a floor fills the air beside it. */
function flowOn(world: FakeWorld, cell: Vec3): void {
  const level = lavaLevelAt(world, cell);
  if (level === null || (level !== SOURCE_LEVEL && level !== LEVEL_STEP && level !== FALLING_LEVEL)) return;
  const below = cell.offset(0, -1, 0);
  if (lavaLevelAt(world, below) !== null) return;
  if (isAirAt(world, below)) {
    world.setCell(below, { name: "lava", properties: { level: FALLING_LEVEL } });
    return;
  }
  if (level === FALLING_LEVEL || LAVA_CANNOT_ENTER.has(world.blockAt(below)?.name ?? "")) return;
  for (const [dx, dz] of SIDES) {
    const beside = cell.offset(dx, 0, dz);
    if (isAirAt(world, beside)) world.setCell(beside, { name: "lava", properties: { level: level + LEVEL_STEP } });
  }
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
      flowOn(world, entry.cell);
    }
  });
}
