// The night shelter's ground: where a closed hole can be dug, why a column cannot hold one, which carried block roofs it.
import { isCanopy } from "../block-kinds.ts";
import { areaKey, type BlockArea, type BlockKind, type BotRuntime, type CarriedStack, type Position, type ProtectedArea } from "../runtime-client.ts";

/** Cells dug under her feet: she ends with her head two blocks under the ground and the roof a block above it. */
export const DEPTH = 3;
/** How far around her (blocks) a column fit for the hole is looked for: 13 x 13 = 169 columns. */
export const SEARCH_RADIUS = 6;
/** The best spots returned, cheapest first: the flow tries them in turn. */
const MAX_CANDIDATES = 3;
/** A column whose estimated dig is longer than this is skipped: obsidian by hand is 3 x 250 s. */
const MAX_DIG_SECONDS = 60;
// Game knowledge, unmeasured here: the walking speed in blocks a second, and the bare-hand breaking rule (seconds =
// hardness x 1.5 when the block needs no tool, hardness x 5 when it needs one she lacks; Minecraft wiki "Breaking").
// The shelter equips no tool, so by hand is the case unless the runtime's dig equips one.
export const WALK_BLOCKS_PER_SECOND = 4.3;
const HAND_SECONDS_PER_HARDNESS = 1.5;
const WRONG_TOOL_SECONDS_PER_HARDNESS = 5;
/** A runtime that reports no hardness (older): the block counts as diggable at this hardness. */
const UNREPORTED_HARDNESS = 1;
/** The item family of the full blocks that fall when unsupported (`src/world/data/item-families/minecraft.json`). */
const FALLING_BLOCK_FAMILY = "falling_block";
/** How high above her head a solid block counts as cover (a roof, the rock over a mine). */
const COVER_HEIGHT = 24;

export type Face = "north" | "south" | "east" | "west";
/** A neighbour's offset and the face of it that looks back at the hole. */
const NEIGHBOURS: readonly (readonly [number, number, Face])[] = [[1, 0, "west"], [-1, 0, "east"], [0, 1, "north"], [0, -1, "south"]];
/** Feet heights tried in a column, from the height she stands at. */
const FEET_OFFSETS = [0, 1, -1, -2];

export interface ShelterSpot extends Position {
  /** The ground block beside the roof cell that the roof is placed against, and which face of it. */
  readonly support: Position;
  readonly face: Face;
  /**
   * Cells of the hole already open, from the top (0 to {@link DEPTH}): a hole dug before, a pit,
   * or a cave notch under a cap; she starts the hole standing on the first solid cell under them ({@link entryOf}).
   */
  readonly dug: number;
  /** Estimated seconds: the walk plus breaking the cells still solid. */
  readonly cost: number;
}

/** The cell she stands in to start the hole: under its open cells, on the first solid one (or on the hole's floor). */
export function entryOf(spot: ShelterSpot): Position {
  return { x: spot.x, y: spot.y - spot.dug, z: spot.z };
}

export type SpotReason = "open_walls" | "open_floor" | "too_hard" | "unknown_cells" | "protected" | "occupied" | "no_support" | "no_room";
export interface SpotSearch {
  /** The cheapest spots first, at most {@link MAX_CANDIDATES}. */
  readonly spots: readonly ShelterSpot[];
  /** Columns that failed, by the first rule each failed at its best height. */
  readonly reasons: Readonly<Record<SpotReason, number>>;
  readonly columns: number;
}

/** The box `shelterSpots` needs read around `from`: the search columns, one more for their walls, and the cells under the lowest hole. */
export function shelterBox(from: Position): { readonly min: Position; readonly max: Position } {
  const x = Math.floor(from.x);
  const y = Math.floor(from.y);
  const z = Math.floor(from.z);
  const reach = SEARCH_RADIUS + 1;
  return { min: { x: x - reach, y: y - 2 - DEPTH - 1, z: z - reach }, max: { x: x + reach, y: y + 2, z: z + reach } };
}

type CellState = "solid" | "open" | "fluid" | "unknown";

/** The kind of the block at a cell; undefined for a cell outside the read or a name with no kind. */
function kindAt(area: BlockArea, x: number, y: number, z: number): BlockKind | undefined {
  const name = area.blocks.get(areaKey(x, y, z));
  return name === undefined ? undefined : area.kinds[name];
}

/** What a cell is, from the box read's kinds: a cell outside the read or of an unknown kind is `unknown`, never open or solid. */
function cellState(area: BlockArea, x: number, y: number, z: number): CellState {
  const kind = kindAt(area, x, y, z);
  if (kind === undefined || kind.known === false) return "unknown";
  if (kind.fluid === true) return "fluid";
  return kind.solid ? "solid" : "open";
}

/** A column and the feet height chosen for its hole; `dug` are the cells dug from the top (`feet - 1`) down. */
interface Column {
  readonly area: BlockArea;
  readonly x: number;
  readonly z: number;
  readonly feet: number;
}

const dugHeights = (column: Column) => Array.from({ length: DEPTH }, (_, index) => column.feet - 1 - index);
const stateIn = (column: Column, dx: number, y: number, dz: number) => cellState(column.area, column.x + dx, y, column.z + dz);
const dugStates = (column: Column) => dugHeights(column).map((y) => stateIn(column, 0, y, 0));
/** The four neighbours of each dug cell as `[state, inside]`: `inside` for the cells she stands and breathes in, which must be solid. */
const wallStates = (column: Column) => dugHeights(column).flatMap((y, index) => NEIGHBOURS.map(([dx, dz]): readonly [CellState, boolean] => [stateIn(column, dx, y, dz), index > 0]));

/**
 * The feet height of a column's hole: the first of her height, one up, one down, two down whose feet and head cells are
 * open. A solid floor comes first (a slope: the ground she can stand on); else a floor that is not solid, which makes
 * the column a hole dug before or a cave, which the checks then name.
 */
function bestFeetHeight(area: BlockArea, x: number, z: number, height: number): number | null {
  for (const onSolidFloor of [true, false]) {
    for (const offset of FEET_OFFSETS) {
      const feet = height + offset;
      if (cellState(area, x, feet, z) !== "open" || cellState(area, x, feet + 1, z) !== "open") continue;
      if ((cellState(area, x, feet - 1, z) === "solid") === onSolidFloor) return feet;
    }
  }
  return null;
}

/** Whether a cell the column needs to stand in was never read (an unloaded chunk), so "no room" would be a guess. */
function standingCellUnknown(area: BlockArea, x: number, z: number, height: number): boolean {
  return FEET_OFFSETS.some((offset) => [0, 1].some((up) => cellState(area, x, height + offset + up, z) === "unknown"));
}

const hasUnknownCell = (column: Column) =>
  dugStates(column).includes("unknown") || stateIn(column, 0, column.feet - 1 - DEPTH, 0) === "unknown" || wallStates(column).some(([state]) => state === "unknown");

/** A dug cell that is fluid, a wall of the cells she is in that is not solid, a fluid beside the roof cell (it would flood in once dug). */
const hasOpenWalls = (column: Column) =>
  dugStates(column).includes("fluid") || wallStates(column).some(([state, inside]) => (inside ? state !== "solid" : state === "fluid"));

/** The cell under the hole not solid, or an open cell under a solid dug one (a cave inside the hole). */
function hasOpenFloor(column: Column): boolean {
  if (stateIn(column, 0, column.feet - 1 - DEPTH, 0) !== "solid") return true;
  const states = dugStates(column);
  const firstSolid = states.indexOf("solid");
  return firstSolid >= 0 && states.slice(firstSolid).includes("open");
}

const dugCount = (column: Column) => dugStates(column).filter((state) => state === "open").length;

/** Seconds to break the solid dug cells by hand; Infinity when one cannot be broken. */
function digSeconds(column: Column): number {
  let seconds = 0;
  for (const y of dugHeights(column)) {
    const kind = kindAt(column.area, column.x, y, column.z);
    if (kind === undefined || !kind.solid) continue;
    if (kind.hardness === null) return Number.POSITIVE_INFINITY;
    seconds += (kind.hardness ?? UNREPORTED_HARDNESS) * (kind.harvest === null ? HAND_SECONDS_PER_HARDNESS : WRONG_TOOL_SECONDS_PER_HARDNESS);
  }
  return seconds;
}

const isTooHard = (column: Column) => digSeconds(column) > MAX_DIG_SECONDS;

const isInArea = ({ min, max }: ProtectedArea, x: number, y: number, z: number) => x >= min.x && x <= max.x && y >= min.y && y <= max.y && z >= min.z && z <= max.z;
const isProtected = (column: Column, areas: readonly ProtectedArea[]) =>
  [...dugHeights(column), column.feet, column.feet + 1].some((y) => areas.some((area) => isInArea(area, column.x, y, column.z)));

/** Someone floored into the column between its floor and its head cell. */
const isOccupied = (column: Column, occupants: readonly Position[]) =>
  occupants.some((at) => Math.floor(at.x) === column.x && Math.floor(at.z) === column.z && Math.floor(at.y) >= column.feet - DEPTH && Math.floor(at.y) <= column.feet + 1);

/** The solid neighbour of the roof cell that the roof block is placed against. */
function supportOf(column: Column): { readonly support: Position; readonly face: Face } | null {
  const roof = column.feet - 1;
  const found = NEIGHBOURS.find(([dx, dz]) => stateIn(column, dx, roof, dz) === "solid");
  return found === undefined ? null : { support: { x: column.x + found[0], y: roof, z: column.z + found[1] }, face: found[2] };
}

/** The first rule the column fails at its chosen height, in the order a model reads the counts (water before caves before hardness...). */
function failedRule(column: Column, areas: readonly ProtectedArea[], occupants: readonly Position[]): SpotReason | null {
  if (hasUnknownCell(column)) return "unknown_cells";
  if (hasOpenWalls(column)) return "open_walls";
  if (hasOpenFloor(column)) return "open_floor";
  if (isTooHard(column)) return "too_hard";
  if (isProtected(column, areas)) return "protected";
  if (isOccupied(column, occupants)) return "occupied";
  return supportOf(column) === null ? "no_support" : null;
}

interface SearchInput {
  readonly area: BlockArea;
  readonly from: Position;
  readonly areas: readonly ProtectedArea[];
  readonly occupants: readonly Position[];
}

/** A spot, or the reason the column at `x z` holds none. */
function spotOrReason(input: SearchInput, x: number, z: number): ShelterSpot | SpotReason {
  const { area, from } = input;
  const feet = bestFeetHeight(area, x, z, Math.floor(from.y));
  if (feet === null) return standingCellUnknown(area, x, z, Math.floor(from.y)) ? "unknown_cells" : "no_room";
  const column: Column = { area, x, z, feet };
  const reason = failedRule(column, input.areas, input.occupants);
  if (reason !== null) return reason;
  const walk = Math.hypot(x - Math.floor(from.x), z - Math.floor(from.z)) / WALK_BLOCKS_PER_SECOND;
  return { x, y: feet, z, ...supportOf(column)!, dug: dugCount(column), cost: walk + digSeconds(column) };
}

/**
 * The best places within {@link SEARCH_RADIUS} of `from` to dig a hole {@link DEPTH} deep that stays closed, cheapest
 * first (estimated seconds, then distance), and for the columns that do not qualify the first rule each failed.
 * `occupants`: where players and mobs stand, from the status (two bots never share a 1x1 hole).
 */
export function shelterSpots(area: BlockArea, from: Position, areas: readonly ProtectedArea[], occupants: readonly Position[] = []): SpotSearch {
  const input: SearchInput = { area, from, areas, occupants };
  const reasons: Record<SpotReason, number> = { open_walls: 0, open_floor: 0, too_hard: 0, unknown_cells: 0, protected: 0, occupied: 0, no_support: 0, no_room: 0 };
  const spots: ShelterSpot[] = [];
  const [fx, fz] = [Math.floor(from.x), Math.floor(from.z)];
  for (let dx = -SEARCH_RADIUS; dx <= SEARCH_RADIUS; dx += 1) {
    for (let dz = -SEARCH_RADIUS; dz <= SEARCH_RADIUS; dz += 1) {
      const outcome = spotOrReason(input, fx + dx, fz + dz);
      if (typeof outcome === "string") reasons[outcome] += 1;
      else spots.push(outcome);
    }
  }
  const distance = (spot: ShelterSpot) => Math.hypot(spot.x - fx, spot.z - fz);
  spots.sort((a, b) => a.cost - b.cost || distance(a) - distance(b));
  return { spots: spots.slice(0, MAX_CANDIDATES), reasons, columns: (2 * SEARCH_RADIUS + 1) ** 2 };
}

const REASON_WORDS: Readonly<Record<SpotReason, string>> = {
  open_walls: "water or open walls",
  open_floor: "cave or open floor",
  too_hard: "too hard or unbreakable",
  unknown_cells: "unknown cells",
  protected: "protected",
  occupied: "someone in it",
  no_support: "nothing to roof against",
  no_room: "no room to stand",
};

/** The failure text for a search with no spot: how many columns failed for which reason, largest first. */
export function describeNoSpot(search: SpotSearch): string {
  const counts = (Object.keys(REASON_WORDS) as SpotReason[])
    .filter((reason) => search.reasons[reason] > 0)
    .sort((a, b) => search.reasons[b] - search.reasons[a])
    .map((reason) => `${search.reasons[reason]} ${REASON_WORDS[reason]}`);
  return `no ground near here to dig a closed hole in (of ${search.columns} columns up to ${SEARCH_RADIUS} blocks along each axis: ${counts.join(", ")}): go_to another patch of dry, solid ground and dig_shelter there`;
}

/**
 * The carried block she roofs the hole with: a full solid cube that does not fall, never one of `needed` (the
 * objective's materials), the largest stack first (ties by name); null when she carries none. `kinds` are the
 * runtime's block kinds of the carried names.
 */
export function roofBlock(inventory: readonly CarriedStack[], kinds: Readonly<Record<string, BlockKind>>, needed: ReadonlySet<string> = new Set()): string | null {
  const counts = new Map<string, number>();
  for (const stack of inventory) {
    const kind = kinds[stack.name];
    const roofs = kind?.solid === true && kind.fullCube === true && stack.families?.includes(FALLING_BLOCK_FAMILY) !== true;
    if (roofs && !needed.has(stack.name)) counts.set(stack.name, (counts.get(stack.name) ?? 0) + stack.count);
  }
  const ranked = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return ranked[0]?.[0] ?? null;
}

/**
 * Whether something solid is over her head (canopy does not count): underground or under a roof the night is no worse
 * than the day (live 2026-10-07: Ayla, at night in a mine shaft, found no ground to dig a hole in).
 */
export function coverOver(area: BlockArea, at: Position): boolean {
  const x = Math.floor(at.x);
  const z = Math.floor(at.z);
  const head = Math.floor(at.y) + 1;
  for (let y = head + 1; y <= head + COVER_HEIGHT; y += 1) {
    const kind = kindAt(area, x, y, z);
    if (kind?.solid === true && !isCanopy(kind)) return true;
  }
  return false;
}

/** Reads the column over her head; read by P4-18 T1a (plan 2026-11-08-p4-18), no effect until then. */
export async function underCover(runtime: BotRuntime, at: Position): Promise<boolean> {
  const x = Math.floor(at.x);
  const z = Math.floor(at.z);
  const head = Math.floor(at.y) + 1;
  return coverOver(await runtime.blocksIn({ x, y: head + 1, z }, { x, y: head + COVER_HEIGHT, z }), at);
}

/**
 * The cells whose state decides whether the hole stays closed and dry: the {@link DEPTH} dug cells and the four
 * neighbours of each. The flow reads them one by one before walking to the spot (`cellsAt`: a waterlogged block shows
 * only per cell, never in a box's per-name kinds).
 */
export function spotCells(spot: Position): readonly Position[] {
  return Array.from({ length: DEPTH }, (_, index) => spot.y - 1 - index).flatMap((y) => [
    { x: spot.x, y, z: spot.z },
    ...NEIGHBOURS.map(([dx, dz]) => ({ x: spot.x + dx, y, z: spot.z + dz })),
  ]);
}

/** Whether `position` is in the shelter's hole: its column, with her feet in the dug cells. */
export function isInHole(position: Position, spot: ShelterSpot): boolean {
  return Math.floor(position.x) === spot.x && Math.floor(position.z) === spot.z && Math.floor(position.y) <= spot.y - 1;
}
