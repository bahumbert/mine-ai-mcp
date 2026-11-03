/** The chunks a template world must hold so lane servers need not generate them: computed from the scenarios and the lane layout, never listed. */
import { compileScenario, type Scenario } from "mine-labs";
import { placeScenario } from "../shared/placement.ts";
import { controlChunkOf, laneOf } from "./lanes.ts";
import type { GameruleDefaults } from "./settings.ts";

/** A rectangle of chunks in chunk coordinates (a block's chunk is `floor(block / 16)`), both ends inclusive. */
export interface ChunkBox {
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
}

export interface TemplateAreaOptions {
  /** Lanes 1..lanes get the union of the lane scenarios' boxes. */
  readonly lanes: number;
  /** The server's view distance in chunks (`view-distance` of its `server.properties`): the caller reads it, this file holds no value. */
  readonly viewChunks: number;
  /** The fresh-server gamerule values `placeScenario` keys by; a census without a server leaves them out, which changes only the key, never where a scenario goes. */
  readonly defaults?: GameruleDefaults;
}

/** Mine Labs does not export its region type. */
type SetupRegion = NonNullable<ReturnType<typeof compileScenario>["region"]>;

const BLOCKS_PER_CHUNK = 16;

function chunkOfBlock(block: number): number {
  return Math.floor(block / BLOCKS_PER_CHUNK);
}

function requireWhole(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) throw new RangeError(`${name} ${value} is not a whole number of at least 0`);
}

/** The chunks a region covers, grown by `reach` chunks on every side. */
function chunkBoxOf(region: SetupRegion, reach: number): ChunkBox {
  return {
    minX: chunkOfBlock(region.minX) - reach,
    minZ: chunkOfBlock(region.minZ) - reach,
    maxX: chunkOfBlock(region.maxX) + reach,
    maxZ: chunkOfBlock(region.maxZ) + reach,
  };
}

/**
 * A scenario's boxes in its own arena coordinates: its pinned arena grown by what a bot at its edge sees, and the
 * scratch copy Mine Labs parks beside it (pinned, never viewed). None for a world the seed decides, another dimension,
 * or a scenario that names no absolute coordinate.
 */
function boxesOfScenario(scenario: Scenario, reach: number): ChunkBox[] {
  if (scenario.world.type !== "flat" || scenario.world.dimension !== "overworld") return [];
  const { region, snapshot } = compileScenario(scenario);
  if (region === null) return [];
  // The pinned regions are the arena and its scratch copy; the arena is inside its own grown box, so listing it again at reach 0 adds nothing.
  return [chunkBoxOf(region, reach + 1), ...(snapshot?.pin ?? []).map(pinned => chunkBoxOf(pinned, 0))];
}

function shiftedAlongZ(box: ChunkBox, chunks: number): ChunkBox {
  return { ...box, minZ: box.minZ + chunks, maxZ: box.maxZ + chunks };
}

/** Where each scenario goes decides which boxes land in lanes (shifted per lane) and which at lane 0 (a server of its own). */
function placedBoxes(scenarios: readonly Scenario[], options: TemplateAreaOptions): { lane: ChunkBox[]; own: ChunkBox[] } {
  const reach = options.viewChunks;
  const lane: ChunkBox[] = [];
  const own: ChunkBox[] = [];
  for (const scenario of scenarios) {
    const placement = placeScenario(scenario, options.defaults ?? {});
    if (placement.kind === "lane") lane.push(...boxesOfScenario(placement.scenario, reach));
    else own.push(...boxesOfScenario(scenario, reach));
  }
  return { lane, own };
}

/** One row band of the union: chunks z `minZ`..`maxZ` hold the same x spans. */
interface Band {
  minZ: number;
  maxZ: number;
  spans: [number, number][];
}

/** The x spans of the boxes covering the band from `z` up to the next edge, overlapping and touching spans joined. */
function spansAt(boxes: readonly ChunkBox[], z: number): [number, number][] {
  const covering = boxes.filter(box => box.minZ <= z && z <= box.maxZ).sort((a, b) => a.minX - b.minX);
  const spans: [number, number][] = [];
  for (const box of covering) {
    const last = spans.at(-1);
    if (last !== undefined && box.minX <= last[1] + 1) last[1] = Math.max(last[1], box.maxX);
    else spans.push([box.minX, box.maxX]);
  }
  return spans;
}

/** The union as bands: each edge of a box starts a band, and bands with equal spans that touch are one, so the result depends on the union alone. */
function bandsOf(boxes: readonly ChunkBox[]): Band[] {
  const starts = [...new Set(boxes.flatMap(box => [box.minZ, box.maxZ + 1]))].sort((a, b) => a - b);
  const bands: Band[] = [];
  for (const [index, z] of starts.entries()) {
    const next = starts[index + 1];
    if (next === undefined) break;
    const spans = spansAt(boxes, z);
    if (spans.length === 0) continue;
    const previous = bands.at(-1);
    if (previous !== undefined && previous.maxZ + 1 === z && JSON.stringify(previous.spans) === JSON.stringify(spans)) previous.maxZ = next - 1;
    else bands.push({ minZ: z, maxZ: next - 1, spans });
  }
  return bands;
}

/** Distinct chunks in `boxes`; chunks lying in several boxes count once. */
export function chunkCount(boxes: readonly ChunkBox[]): number {
  return bandsOf(boxes).reduce((total, band) => total + (band.maxZ - band.minZ + 1) * band.spans.reduce((width, [from, to]) => width + to - from + 1, 0), 0);
}

/**
 * The chunks the template holds: for lanes 1..lanes the union of every lane scenario's boxes (shifted by the lane's
 * offset) and the lane's control chunk, at lane 0 the boxes of flat scenarios on a server of their own, and the spawn
 * box. The list is canonical (non-overlapping, sorted, rows of equal x spans joined) and the same whatever the order of
 * `scenarios`, so a key built from it is stable. It is not the fewest boxes: a caller batching by 256 chunks packs across boxes.
 */
export function templateArea(scenarios: readonly Scenario[], options: TemplateAreaOptions): ChunkBox[] {
  requireWhole("lanes", options.lanes);
  requireWhole("viewChunks", options.viewChunks);
  const { lane, own } = placedBoxes(scenarios, options);
  const spawnReach = options.viewChunks + 1;
  const boxes: ChunkBox[] = [{ minX: -spawnReach, minZ: -spawnReach, maxX: spawnReach, maxZ: spawnReach }, ...own];
  if (lane.length > 0) {
    for (let index = 1; index <= options.lanes; index++) {
      const placed = laneOf(index);
      const control = controlChunkOf(placed);
      const chunk = { x: chunkOfBlock(control.x), z: chunkOfBlock(control.z) };
      boxes.push({ minX: chunk.x, minZ: chunk.z, maxX: chunk.x, maxZ: chunk.z });
      boxes.push(...lane.map(box => shiftedAlongZ(box, chunkOfBlock(placed.offset.z))));
    }
  }
  return bandsOf(boxes).flatMap(band => band.spans.map(([minX, maxX]) => ({ minX, minZ: band.minZ, maxX, maxZ: band.maxZ }))).sort((a, b) => a.minZ - b.minZ || a.minX - b.minX);
}
