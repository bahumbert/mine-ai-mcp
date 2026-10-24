/**
 * The server's lava flowing, as it answered contract check `lava-over-hole` (Mine Labs 1.21.4, 2026-10-24): every step takes 30
 * ticks from the tick the lava cell appeared. A lava source or a flowing level 2 with a floor under it fills each open
 * neighbour (air, on the four sides) with a flowing cell two levels higher (2, then 4). A level 2 with air under it pours
 * into the air as a falling column (level 8) and fills no cell beside it; with a falling column or lava under it, it fills
 * nothing beside it either.
 * Not modelled, because not measured: a cell of level 4 and more spreading, a falling column spreading where it lands, a
 * source over a hole (a hole under a source pours or spreads: nothing is answered), unfed lava drying up, lava meeting water,
 * the Nether's faster flow, anything but air being flowed into, lava updating when a block beside it changes.
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

/** The lava at `cell` flows on once: a level 2 over air pours, a source or a level 2 over a floor fills the air beside it. */
function flowOn(world: FakeWorld, cell: Vec3): void {
  const level = lavaLevelAt(world, cell);
  if (level === null || (level !== SOURCE_LEVEL && level !== LEVEL_STEP)) return;
  const below = cell.offset(0, -1, 0);
  if (lavaLevelAt(world, below) !== null) return;
  if (isAirAt(world, below)) {
    if (level === LEVEL_STEP) world.setCell(below, { name: "lava", properties: { level: FALLING_LEVEL } });
    return;
  }
  for (const [dx, dz] of SIDES) {
    const beside = cell.offset(dx, 0, dz);
    if (isAirAt(world, beside)) world.setCell(beside, { name: "lava", properties: { level: level + LEVEL_STEP } });
  }
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
      else if (!due.has(key)) due.set(key, { cell: block.position, tick: tick + LAVA_FLOW_TICKS });
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
