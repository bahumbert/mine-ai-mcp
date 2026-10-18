/**
 * The farming of one plot, cell by cell, as a player does it: first everything that comes off the soil (ripe crops,
 * grass and flowers), then the drops picked up (the seeds to replant are among them), then every cell tilled and
 * planted. The physical gestures belong to a `FarmBody`; this file decides which gesture each cell gets and keeps
 * the evidence, so it is the same whether the body is a live bot or a test's fake.
 */
import type { TendCell, TendCropsRequest, TendEvidence } from "./contract.js";

/** One block as the decisions need it. */
export interface CellBlock {
  readonly name: string;
  readonly properties: Readonly<Record<string, string | number | boolean>>;
  readonly liquid: boolean;
  /** No collision box: air, grass, flowers, crops. */
  readonly empty: boolean;
  /** A hand can break it (minecraft-data `diggable`): false for air, water, bedrock. */
  readonly breakable: boolean;
}

/** What the game data says of crops (`src/world/block-drops.ts`). */
export interface CropFacts {
  /** Whether the crop is ripe; null when the block is not a crop. */
  isRipe(block: CellBlock): boolean | null;
  /** The item a crop is planted from (an unripe crop's drop); null when not a crop. */
  seedOf(blockName: string): string | null;
}

export interface FarmCell {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Why a till did not change the soil: no hoe in hand, the use failed, it went out but the server was not seen to answer, or it was answered and the block stayed. */
export type TillFailure = { readonly kind: "no hoe" } | { readonly kind: "error"; readonly error: string } | { readonly kind: "unchanged" } | { readonly kind: "unconfirmed" };

/** The physical gestures; each answers null when done, else why not. */
export interface FarmBody {
  read(x: number, y: number, z: number): CellBlock | null;
  /** Walk until the cell is within reach. */
  reach(cell: FarmCell): Promise<string | null>;
  /** Break the block in that cell (a crop, grass) by hand. */
  breakBlock(cell: FarmCell): Promise<string | null>;
  /** Use the best carried hoe on the soil's top face; null when the soil changed, else why not. */
  till(soil: FarmCell): Promise<TillFailure | null>;
  /** Use one `item` on the farmland's top face; done when something grows above it. */
  plant(soil: FarmCell, item: string): Promise<string | null>;
  /** Pick up what the breaks dropped on and around the plot; `left`: the names of the drops it could not get. */
  collectDrops(): Promise<{ readonly left: readonly string[] }>;
  carried(item: string): number;
  hasHoe(): boolean;
}

export type CellDecision = "harvest" | "clear" | "till" | "plant" | { readonly skip: string };

/** What the cell needs, from its soil (at the plot's level) and what stands on it. */
export function decideCell(soil: CellBlock | null, above: CellBlock | null, crops: CropFacts): CellDecision {
  if (soil === null || above === null) return { skip: "unloaded" };
  if (soil.liquid) return { skip: "water" };
  if (above.liquid) return { skip: "under water" };
  const ripe = crops.isRipe(above);
  if (ripe === true) return "harvest";
  if (ripe === false) return { skip: "growing" };
  if (above.breakable) return above.empty ? "clear" : { skip: `occupied by ${above.name}` };
  return soil.name === "farmland" ? "plant" : "till";
}

/** Where a run is, for the action's progress checkpoint. */
export interface TendProgress {
  readonly phase: "clearing" | "collecting drops" | "planting";
  readonly harvested: number;
  readonly cleared: number;
  readonly tilled: number;
  readonly planted: number;
}

export interface TendOutcome {
  readonly evidence: TendEvidence;
  /** Why the run stopped before the end (a stall), else null. */
  readonly stop: string | null;
  /** Why no work was started at all, else null. */
  readonly refused: string | null;
}

/** The plot's cells, row by row, every other row backwards, so the walk never crosses the plot to begin a row. */
function serpentine(request: TendCropsRequest): TendCell[] {
  const cells: TendCell[] = [];
  for (let z = request.min.z; z <= request.max.z; z += 1) {
    const row: TendCell[] = [];
    for (let x = request.min.x; x <= request.max.x; x += 1) row.push({ x, z });
    cells.push(...((z - request.min.z) % 2 === 0 ? row : row.reverse()));
  }
  return cells;
}

/**
 * Farm the plot. `stop` is asked before each cell's gestures: a reason ends the run there, with what was done (the
 * caller's stall watch).
 */
export async function tendPlot(
  request: TendCropsRequest,
  body: FarmBody,
  crops: CropFacts,
  stop: () => string | null = () => null,
  observe: (progress: TendProgress) => void = () => {},
): Promise<TendOutcome> {
  const cells = serpentine(request);
  const soilOf = (cell: TendCell): FarmCell => ({ x: cell.x, y: request.y, z: cell.z });
  const aboveOf = (cell: TendCell): FarmCell => ({ x: cell.x, y: request.y + 1, z: cell.z });
  const decide = (cell: TendCell) => decideCell(body.read(cell.x, request.y, cell.z), body.read(cell.x, request.y + 1, cell.z), crops);
  const counts = { harvested: 0, cleared: 0, tilled: 0, planted: 0 };
  let dropsLeft: readonly string[] = [];
  let phase: TendProgress["phase"] = "clearing";
  const report = (next: TendProgress["phase"] = phase) => {
    phase = next;
    observe({ phase, ...counts });
  };
  const hoeCarriedAtStart = body.hasHoe();
  const tilledSoil: Record<string, number> = {};
  const till = { hoeGone: false, untillable: {} as Record<string, TendCell[]> };
  const skipped: Record<string, TendCell[]> = {};
  const skip = (cell: TendCell, reason: string) => (skipped[reason] ??= []).push({ x: cell.x, z: cell.z });
  const inventoryBefore = new Map<string, number>();
  const remember = (item: string) => {
    if (!inventoryBefore.has(item)) inventoryBefore.set(item, body.carried(item));
  };
  const evidence = (): TendEvidence => ({
    cells: cells.length,
    ...counts,
    tilledSoil,
    untillable: till.untillable,
    gained: Object.fromEntries([...inventoryBefore].map(([item, before]) => [item, body.carried(item) - before]).filter(([, change]) => change !== 0)),
    skipped,
    dropsLeft: [...dropsLeft],
    after: plotAfter(request, cells, body, crops),
  });

  if (request.plant !== null) remember(request.plant);

  // First what comes off the soil, so its drops (a harvest's seeds) are in hand before planting.
  const seedFor = new Map<string, string>();
  /** Cells already reported skipped in the first pass. */
  const settled = new Set<string>();
  let broke = false;
  report("clearing");
  for (const cell of cells) {
    const decision = decide(cell);
    if (!(decision === "clear" || (decision === "harvest" && request.harvest))) continue;
    const reason = stop();
    if (reason !== null) return { evidence: evidence(), stop: reason, refused: null };
    const crop = body.read(cell.x, request.y + 1, cell.z)!.name;
    const unreachable = await body.reach(aboveOf(cell));
    const failed = unreachable === null ? await body.breakBlock(aboveOf(cell)) : null;
    if (unreachable !== null || failed !== null) {
      skip(cell, unreachable !== null ? `unreachable: ${unreachable}` : `could not break ${crop}: ${failed}`);
      settled.add(`${cell.x},${cell.z}`);
      continue;
    }
    broke = true;
    if (decision === "clear") counts.cleared += 1;
    else {
      counts.harvested += 1;
      const seed = crops.seedOf(crop);
      if (seed !== null) {
        seedFor.set(`${cell.x},${cell.z}`, seed);
        remember(seed);
      }
      for (const item of [crop, ...(seed === null ? [] : [seed])]) remember(item);
    }
    report();
  }
  if (broke) {
    report("collecting drops");
    dropsLeft = (await body.collectDrops()).left;
  }
  report("planting");

  // Then every cell tilled and planted: with the item asked for, else (a cell harvested here) the crop's own seed. An
  // item that does not take is not tried again (live 2026-10-03: asked to plant "wheat", the harvest, not the seed,
  // all 13 harvested cells stayed empty).
  const unplantable = new Set<string>();
  const choices = (cell: TendCell): string[] =>
    [...new Set([request.plant, seedFor.get(`${cell.x},${cell.z}`) ?? null])].filter((item): item is string => item !== null && !unplantable.has(item));
  for (const cell of cells) {
    if (settled.has(`${cell.x},${cell.z}`)) continue;
    let decision = decide(cell);
    if (decision === "harvest") {
      skip(cell, "ripe, not harvested");
      continue;
    }
    if (typeof decision === "object") {
      skip(cell, decision.skip);
      continue;
    }
    if (decision === "clear") continue;
    if (decision === "till" && (!request.till || till.hoeGone || !body.hasHoe())) {
      skip(cell, !request.till ? "not farmland" : hoeCarriedAtStart ? NO_HOE_LEFT : NO_HOE);
      continue;
    }
    if (decision === "plant" && choices(cell).length === 0) {
      if (request.plant !== null) skip(cell, `${request.plant} cannot be planted`);
      continue;
    }
    const reason = stop();
    if (reason !== null) return { evidence: evidence(), stop: reason, refused: null };
    const unreachable = await body.reach(soilOf(cell));
    if (unreachable !== null) {
      skip(cell, `unreachable: ${unreachable}`);
      continue;
    }
    if (decision === "till") {
      const soil = body.read(cell.x, request.y, cell.z)!.name;
      const failure = await tillCell(body, soilOf(cell), () => decide(cell) === "till");
      if (failure !== null) {
        skip(cell, noteTillFailure(till, failure, soil, cell));
        continue;
      }
      counts.tilled += 1;
      tilledSoil[soil] = (tilledSoil[soil] ?? 0) + 1;
      report();
    }
    let why: string | null = null;
    for (const item of choices(cell)) {
      if (body.carried(item) === 0) {
        why = `no ${item} left`;
        continue;
      }
      if ((await body.plant(soilOf(cell), item)) === null) {
        counts.planted += 1;
        report();
        why = null;
        break;
      }
      unplantable.add(item);
      why = `${item} cannot be planted`;
    }
    if (why !== null) skip(cell, why);
  }
  return { evidence: evidence(), stop: null, refused: null };
}

const NO_HOE_LEFT = "no hoe left";
const NO_HOE = "no hoe";
const TILL_NOT_CONFIRMED = "till not confirmed (server behind)";

/** What a failed till teaches: no hoe ends the tilling, an unchanged block is untillable, an error is neither. Returns the skip reason. */
function noteTillFailure(till: { hoeGone: boolean; untillable: Record<string, TendCell[]> }, failure: TillFailure, soil: string, cell: TendCell): string {
  if (failure.kind === "no hoe") till.hoeGone = true;
  if (failure.kind === "unchanged") (till.untillable[soil] ??= []).push({ x: cell.x, z: cell.z });
  return failure.kind === "no hoe" ? NO_HOE_LEFT : failure.kind === "error" ? `till failed: ${failure.error}` : failure.kind === "unconfirmed" ? TILL_NOT_CONFIRMED : `not tillable (${soil})`;
}

/** Till one cell: coarse dirt takes two uses, the first makes it dirt. Null when the cell is farmland now, else why not. */
async function tillCell(body: FarmBody, soil: FarmCell, needsTill: () => boolean): Promise<TillFailure | null> {
  let failure: TillFailure | null = null;
  for (let use = 0; use < 2 && needsTill(); use += 1) {
    failure = await body.till(soil);
    if (failure !== null) break;
  }
  return needsTill() ? (failure ?? { kind: "unchanged" }) : null;
}

/** The plot as it stands now: crops by block and age, empty and dry farmland, water. */
function plotAfter(request: TendCropsRequest, cells: readonly TendCell[], body: FarmBody, crops: CropFacts): TendEvidence["after"] {
  const after = { crops: {} as Record<string, number>, emptyFarmland: 0, dryFarmland: 0, water: 0 };
  for (const cell of cells) {
    const soil = body.read(cell.x, request.y, cell.z);
    const above = body.read(cell.x, request.y + 1, cell.z);
    if (soil === null || above === null) continue;
    if (soil.liquid) after.water += 1;
    if (soil.name !== "farmland") continue;
    if (Number(soil.properties.moisture ?? 7) < 7) after.dryFarmland += 1;
    const ripe = crops.isRipe(above);
    if (ripe === null) {
      if (!above.breakable) after.emptyFarmland += 1;
      continue;
    }
    const key = `${above.name} age ${String(above.properties.age)}${ripe ? " ripe" : ""}`;
    after.crops[key] = (after.crops[key] ?? 0) + 1;
  }
  return after;
}
