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
 * What one tend request keeps across the attempts a reflex cuts it into (spec 2026-10-18, R2): the counts, the baselines
 * the evidence is measured against, what the first attempts learned (the seeds, the items that do not take, the hoe
 * gone) and whether harvest drops still lie on the plot. `skipped` and `settled` belong to one attempt: each attempt
 * reads the plot again and reports the cells it leaves.
 */
interface TendState {
  readonly request: TendCropsRequest;
  readonly cells: readonly TendCell[];
  readonly crops: CropFacts;
  readonly observe: (progress: TendProgress) => void;
  readonly counts: { harvested: number; cleared: number; tilled: number; planted: number };
  readonly hoeCarriedAtStart: boolean;
  readonly tilledSoil: Record<string, number>;
  readonly till: { hoeGone: boolean; untillable: Record<string, TendCell[]> };
  /** The first carried count of each item the request touched, so `gained` covers every attempt. */
  readonly inventoryBefore: Map<string, number>;
  /** The seed each harvested cell gave, by "x,z", for replanting it. */
  readonly seedFor: Map<string, string>;
  /** Items that did not take when planted: not tried again. */
  readonly unplantable: Set<string>;
  skipped: Record<string, TendCell[]>;
  settled: Set<string>;
  dropsLeft: readonly string[];
  /** A crop or tuft was broken and its drops have not been fetched to the end yet. */
  dropsPending: boolean;
  phase: TendProgress["phase"];
}

/** One attempt: the state of the request, the body of this attempt, and its stall check. */
interface TendAttempt {
  readonly state: TendState;
  readonly body: FarmBody;
  readonly stop: () => string | null;
}

const cellKey = (cell: TendCell) => `${cell.x},${cell.z}`;
const soilOf = (state: TendState, cell: TendCell): FarmCell => ({ x: cell.x, y: state.request.y, z: cell.z });
const aboveOf = (state: TendState, cell: TendCell): FarmCell => ({ x: cell.x, y: state.request.y + 1, z: cell.z });
const decide = (a: TendAttempt, cell: TendCell) =>
  decideCell(a.body.read(cell.x, a.state.request.y, cell.z), a.body.read(cell.x, a.state.request.y + 1, cell.z), a.state.crops);

function report(state: TendState, next: TendProgress["phase"] = state.phase): void {
  state.phase = next;
  state.observe({ phase: next, ...state.counts });
}

function skip(state: TendState, cell: TendCell, reason: string): void {
  (state.skipped[reason] ??= []).push({ x: cell.x, z: cell.z });
}

function remember(state: TendState, body: FarmBody, item: string): void {
  if (!state.inventoryBefore.has(item)) state.inventoryBefore.set(item, body.carried(item));
}

function evidenceOf(a: TendAttempt): TendEvidence {
  const { state, body } = a;
  return {
    cells: state.cells.length,
    ...state.counts,
    tilledSoil: state.tilledSoil,
    untillable: state.till.untillable,
    gained: Object.fromEntries([...state.inventoryBefore].map(([item, before]) => [item, body.carried(item) - before]).filter(([, change]) => change !== 0)),
    skipped: state.skipped,
    dropsLeft: [...state.dropsLeft],
    after: plotAfter(state.request, state.cells, body, state.crops),
  };
}

/**
 * Take the request: the counts and baselines are made once here (the plant item is remembered before anything is
 * planted), and each `attempt` reads the plot again and does only what is left, so a reflex that cuts a tend loses nothing.
 */
export function beginTendPlot(
  request: TendCropsRequest,
  body: FarmBody,
  crops: CropFacts,
  observe: (progress: TendProgress) => void = () => {},
): { attempt(body: FarmBody, stop?: () => string | null): Promise<TendOutcome> } {
  const state: TendState = {
    request, crops, observe,
    cells: serpentine(request),
    counts: { harvested: 0, cleared: 0, tilled: 0, planted: 0 },
    hoeCarriedAtStart: body.hasHoe(),
    tilledSoil: {},
    till: { hoeGone: false, untillable: {} },
    inventoryBefore: new Map(),
    seedFor: new Map(),
    unplantable: new Set(),
    skipped: {},
    settled: new Set(),
    dropsLeft: [],
    dropsPending: false,
    phase: "clearing",
  };
  if (request.plant !== null) remember(state, body, request.plant);
  return { attempt: (attemptBody, stop = () => null) => tendAttempt({ state, body: attemptBody, stop }) };
}

/**
 * Farm the plot. `stop` is asked before each cell's gestures: a reason ends the run there, with what was done (the
 * caller's stall watch).
 */
export function tendPlot(
  request: TendCropsRequest,
  body: FarmBody,
  crops: CropFacts,
  stop: () => string | null = () => null,
  observe: (progress: TendProgress) => void = () => {},
): Promise<TendOutcome> {
  return beginTendPlot(request, body, crops, observe).attempt(body, stop);
}

async function tendAttempt(a: TendAttempt): Promise<TendOutcome> {
  const { state, body } = a;
  state.skipped = {};
  state.settled = new Set();
  report(state, "clearing");
  const clearingStop = await clearingPass(a);
  if (clearingStop !== null) return { evidence: evidenceOf(a), stop: clearingStop, refused: null };
  if (state.dropsPending) {
    report(state, "collecting drops");
    state.dropsLeft = (await body.collectDrops()).left;
    state.dropsPending = false;
  }
  report(state, "planting");
  const plantingStop = await plantingPass(a);
  return { evidence: evidenceOf(a), stop: plantingStop, refused: null };
}

/** First what comes off the soil, so its drops (a harvest's seeds) are in hand before planting. Returns a stall reason, else null. */
async function clearingPass(a: TendAttempt): Promise<string | null> {
  const { state } = a;
  for (const cell of state.cells) {
    const decision = decide(a, cell);
    if (!(decision === "clear" || (decision === "harvest" && state.request.harvest))) continue;
    const reason = a.stop();
    if (reason !== null) return reason;
    await clearCell(a, cell, decision);
  }
  return null;
}

/** Count what a break took off the soil, and remember the seed a harvested crop is replanted from. */
function recordBreak(a: TendAttempt, cell: TendCell, decision: "clear" | "harvest", crop: string): void {
  const { state, body } = a;
  state.dropsPending = true;
  if (decision === "clear") {
    state.counts.cleared += 1;
    return;
  }
  state.counts.harvested += 1;
  const seed = state.crops.seedOf(crop);
  if (seed !== null) {
    state.seedFor.set(cellKey(cell), seed);
    remember(state, body, seed);
  }
  for (const item of [crop, ...(seed === null ? [] : [seed])]) remember(state, body, item);
}

/** Break what stands on the soil. An abort that lands after the crop came off still counts it (progress is kept before an abort can throw). */
async function clearCell(a: TendAttempt, cell: TendCell, decision: "clear" | "harvest"): Promise<void> {
  const { state, body } = a;
  const above = aboveOf(state, cell);
  const crop = body.read(above.x, above.y, above.z)!.name;
  const unreachable = await body.reach(above);
  let failed: string | null = null;
  if (unreachable === null) {
    try {
      failed = await body.breakBlock(above);
    } catch (error) {
      const now = body.read(above.x, above.y, above.z);
      if (now !== null && now.name !== crop) recordBreak(a, cell, decision, crop);
      throw error;
    }
  }
  if (unreachable !== null || failed !== null) {
    skip(state, cell, unreachable !== null ? `unreachable: ${unreachable}` : `could not break ${crop}: ${failed}`);
    state.settled.add(cellKey(cell));
    return;
  }
  recordBreak(a, cell, decision, crop);
  report(state);
}

/** What may be planted in a cell: the item asked for, else (a cell harvested here) the crop's own seed. */
function plantChoices(state: TendState, cell: TendCell): string[] {
  return [...new Set([state.request.plant, state.seedFor.get(cellKey(cell)) ?? null])]
    .filter((item): item is string => item !== null && !state.unplantable.has(item));
}

/**
 * Then every cell tilled and planted: with the item asked for, else (a cell harvested here) the crop's own seed. An
 * item that does not take is not tried again (live 2026-10-03: asked to plant "wheat", the harvest, not the seed,
 * all 13 harvested cells stayed empty). Returns a stall reason, else null.
 */
async function plantingPass(a: TendAttempt): Promise<string | null> {
  const { state, body } = a;
  for (const cell of state.cells) {
    if (state.settled.has(cellKey(cell))) continue;
    const decision = decide(a, cell);
    if (decision === "harvest") {
      skip(state, cell, "ripe, not harvested");
      continue;
    }
    if (typeof decision === "object") {
      skip(state, cell, decision.skip);
      continue;
    }
    if (decision === "clear") continue;
    if (decision === "till" && (!state.request.till || state.till.hoeGone || !body.hasHoe())) {
      skip(state, cell, !state.request.till ? "not farmland" : state.hoeCarriedAtStart ? NO_HOE_LEFT : NO_HOE);
      continue;
    }
    if (decision === "plant" && plantChoices(state, cell).length === 0) {
      if (state.request.plant !== null) skip(state, cell, `${state.request.plant} cannot be planted`);
      continue;
    }
    const reason = a.stop();
    if (reason !== null) return reason;
    await tendCell(a, cell, decision);
  }
  return null;
}

/** Till (when the cell needs it) and plant one cell. */
async function tendCell(a: TendAttempt, cell: TendCell, decision: "till" | "plant"): Promise<void> {
  const { state, body } = a;
  const unreachable = await body.reach(soilOf(state, cell));
  if (unreachable !== null) {
    skip(state, cell, `unreachable: ${unreachable}`);
    return;
  }
  if (decision === "till" && !(await tillOne(a, cell))) return;
  const why = await plantOne(a, cell);
  if (why !== null) skip(state, cell, why);
}

/** Till one cell and count it; false (with the cell skipped) when it did not take. An abort after the soil turned still counts it. */
async function tillOne(a: TendAttempt, cell: TendCell): Promise<boolean> {
  const { state, body } = a;
  const soil = body.read(cell.x, state.request.y, cell.z)!.name;
  const countTilled = () => {
    state.counts.tilled += 1;
    state.tilledSoil[soil] = (state.tilledSoil[soil] ?? 0) + 1;
  };
  let failure: TillFailure | null;
  try {
    failure = await tillCell(body, soilOf(state, cell), () => decide(a, cell) === "till");
  } catch (error) {
    if (body.read(cell.x, state.request.y, cell.z)?.name === "farmland") countTilled();
    throw error;
  }
  if (failure !== null) {
    skip(state, cell, noteTillFailure(state.till, failure, soil, cell));
    return false;
  }
  countTilled();
  report(state);
  return true;
}

/** Plant one cell from what it may be planted with; null when planted, else why not. An abort after the crop stood still counts it. */
async function plantOne(a: TendAttempt, cell: TendCell): Promise<string | null> {
  const { state, body } = a;
  let why: string | null = null;
  for (const item of plantChoices(state, cell)) {
    if (body.carried(item) === 0) {
      why = `no ${item} left`;
      continue;
    }
    let failed: string | null;
    try {
      failed = await body.plant(soilOf(state, cell), item);
    } catch (error) {
      const above = body.read(cell.x, state.request.y + 1, cell.z);
      if (above !== null && state.crops.isRipe(above) !== null) state.counts.planted += 1;
      throw error;
    }
    if (failed === null) {
      state.counts.planted += 1;
      report(state);
      return null;
    }
    state.unplantable.add(item);
    why = `${item} cannot be planted`;
  }
  return why;
}

const NO_HOE_LEFT = "no hoe left";
const NO_HOE = "no hoe";
const TILL_NOT_CONFIRMED = "till not confirmed (server behind)";

/** What a failed till teaches: no hoe ends the tilling, an unchanged block is untillable, an error is neither. Returns the skip reason. */
function noteTillFailure(till: { hoeGone: boolean; untillable: Record<string, TendCell[]> }, failure: TillFailure, soil: string, cell: TendCell): string {
  if (failure.kind === "no hoe") till.hoeGone = true;
  if (failure.kind === "unchanged" && !(till.untillable[soil] ?? []).some((known) => known.x === cell.x && known.z === cell.z)) (till.untillable[soil] ??= []).push({ x: cell.x, z: cell.z });
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
