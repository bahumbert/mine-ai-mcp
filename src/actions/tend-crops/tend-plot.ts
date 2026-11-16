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

/** What the game data says of the plot: crops (`src/world/block-drops.ts`), ground cover, tilled soil. */
export interface PlotFacts {
  /** Whether the crop is ripe; null when the block is not a crop. */
  isRipe(block: CellBlock): boolean | null;
  /** The age a crop block is ripe at (the loot table's, else its last age); null when the block is not a crop. */
  ripeAge(blockName: string): number | null;
  /** The item a crop is planted from (an unripe crop's drop); null when not a crop. */
  seedOf(blockName: string): string | null;
  /** Whether a player clears this plant off soil (the game's replaceable plants and flowers, never a sapling). */
  isGroundCover(name: string): boolean;
  /** Whether the soil is already tilled (its state holds moisture). */
  isTilledSoil(block: CellBlock): boolean;
}

export interface FarmCell {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Why a till did not change the soil: no hoe in hand, the use failed, it went out but the server was not seen to answer, or it was answered and the block stayed. */
export type TillFailure = { readonly kind: "no hoe" } | { readonly kind: "error"; readonly error: string } | { readonly kind: "unchanged" } | { readonly kind: "unconfirmed" };

/**
 * Why a seed's use grew nothing: none of the item is carried, the use failed before or without an answer (`error`: refused,
 * thrown), it went out but the server was not seen to answer in time (`unconfirmed`: the crop may still arrive), or the
 * server clock moved on far enough and nothing grew (`unchanged`: the only answer that teaches).
 */
export type PlantFailure = { readonly kind: "none carried" } | { readonly kind: "error"; readonly error: string } | { readonly kind: "unconfirmed" } | { readonly kind: "unchanged" };

/** The physical gestures; each answers null when done, else why not. */
export interface FarmBody {
  read(x: number, y: number, z: number): CellBlock | null;
  /** Walk until the cell is within reach. */
  reach(cell: FarmCell): Promise<string | null>;
  /** Break the block in that cell (a crop, grass) by hand. */
  breakBlock(cell: FarmCell): Promise<string | null>;
  /** Use the best carried hoe on the soil's top face; null when the soil changed, else why not. */
  till(soil: FarmCell): Promise<TillFailure | null>;
  /** Use one `item` on the farmland's top face; null when something grows above it, else why not. */
  plant(soil: FarmCell, item: string): Promise<PlantFailure | null>;
  /** Pick up what the breaks dropped on and around the plot; `left`: the names of the drops it could not get. */
  collectDrops(): Promise<{ readonly left: readonly string[] }>;
  carried(item: string): number;
  hasHoe(): boolean;
}

export type CellDecision = "harvest" | "clear" | "till" | "plant" | { readonly skip: string };

/** What the cell needs, from its soil (at the plot's level) and what stands on it. */
export function decideCell(soil: CellBlock | null, above: CellBlock | null, facts: PlotFacts): CellDecision {
  if (soil === null || above === null) return { skip: "unloaded" };
  if (soil.liquid) return { skip: "water" };
  if (above.liquid) return { skip: "under water" };
  const ripe = facts.isRipe(above);
  if (ripe === true) return "harvest";
  if (ripe === false) return { skip: "growing" };
  if (above.breakable && above.empty && facts.isGroundCover(above.name)) return "clear";
  if (above.breakable) return { skip: `occupied by ${above.name}` };
  return facts.isTilledSoil(soil) ? "plant" : "till";
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
  readonly facts: PlotFacts;
  readonly observe: (progress: TendProgress) => void;
  readonly counts: { harvested: number; cleared: number; tilled: number; planted: number };
  readonly hoeCarriedAtStart: boolean;
  /** The crops standing when the request began, read once here: a resumed attempt finds the plot already worked on. */
  readonly before: TendEvidence["before"];
  readonly tilledSoil: Record<string, number>;
  readonly till: { hoeGone: boolean; untillable: Record<string, TendCell[]> };
  /** The first carried count of each item the request touched, so `gained` covers every attempt. */
  readonly inventoryBefore: Map<string, number>;
  /** The seed each harvested cell gave, by "x,z", for replanting it. */
  readonly seedFor: Map<string, string>;
  /** Items the server refused at two different cells with no planting of them between: not tried again this request. */
  readonly unplantable: Set<string>;
  /** Per item and cell (by "x,z"), the last refusal's attempt sequence: one place still counts once across resumes. */
  readonly refusedAt: Map<string, Map<string, number>>;
  plantSeq: number;
  /** Unanswered plantings kept across attempts, until a crop is seen or the empty cell is tried again. */
  readonly pendingPlants: Map<string, { item: string; seq: number; cell: TendCell }>;
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
  decideCell(a.body.read(cell.x, a.state.request.y, cell.z), a.body.read(cell.x, a.state.request.y + 1, cell.z), a.state.facts);

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
    before: state.before,
    after: plotAfter(state.request, state.cells, body, state.facts),
  };
}

/**
 * Take the request: the counts and baselines are made once here (the plant item is remembered before anything is
 * planted), and each `attempt` reads the plot again and does only what is left, so a reflex that cuts a tend loses nothing.
 */
export function beginTendPlot(
  request: TendCropsRequest,
  body: FarmBody,
  facts: PlotFacts,
  observe: (progress: TendProgress) => void = () => {},
): { attempt(body: FarmBody, stop?: () => string | null): Promise<TendOutcome> } {
  const cells = serpentine(request);
  const state: TendState = {
    request, facts, observe, cells,
    counts: { harvested: 0, cleared: 0, tilled: 0, planted: 0 },
    hoeCarriedAtStart: body.hasHoe(),
    before: { crops: cropsOf(request, cells, body, facts).crops },
    tilledSoil: {},
    till: { hoeGone: false, untillable: {} },
    inventoryBefore: new Map(),
    seedFor: new Map(),
    unplantable: new Set(),
    refusedAt: new Map(),
    plantSeq: 0,
    pendingPlants: new Map(),
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
  facts: PlotFacts,
  stop: () => string | null = () => null,
  observe: (progress: TendProgress) => void = () => {},
): Promise<TendOutcome> {
  return beginTendPlot(request, body, facts, observe).attempt(body, stop);
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
  const seed = state.facts.seedOf(crop);
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
 * item the server answers "nothing grew" at two different cells (no planting of it between) is not tried again (live
 * 2026-10-03: asked to plant "wheat", the harvest, not the seed, all 13 harvested cells stayed empty); one answer, a
 * failed use and an unanswered use teach nothing. Every cell left is reported with its reason. Returns a stall reason, else null.
 */
async function plantingPass(a: TendAttempt): Promise<string | null> {
  try {
    return await plantCells(a);
  } finally {
    reconcilePending(a);
  }
}

/** Count an observed planting and discard only the refusals older than that use, even when its answer arrived late. */
function plantSucceeded(state: TendState, item: string, seq: number): void {
  state.counts.planted += 1;
  const refusals = state.refusedAt.get(item);
  if (refusals !== undefined) {
    for (const [key, refusedSeq] of refusals) if (refusedSeq < seq) refusals.delete(key);
  }
  if ((refusals?.size ?? 0) < REFUSALS_TO_SWITCH_OFF) state.unplantable.delete(item);
  report(state);
}

/** A pending use whose crop now stands counts once, and no longer leaves the cell skipped as not confirmed. */
function reconcilePending(a: TendAttempt): void {
  const { state, body } = a;
  for (const [key, { item, seq, cell }] of state.pendingPlants) {
    const above = body.read(cell.x, state.request.y + 1, cell.z);
    if (above === null || state.facts.isRipe(above) === null) continue;
    plantSucceeded(state, item, seq);
    state.pendingPlants.delete(key);
    const stillEmpty = state.skipped[PLANT_NOT_CONFIRMED]?.filter((skipped) => cellKey(skipped) !== key);
    if (stillEmpty?.length) state.skipped[PLANT_NOT_CONFIRMED] = stillEmpty;
    else delete state.skipped[PLANT_NOT_CONFIRMED];
  }
}

async function plantCells(a: TendAttempt): Promise<string | null> {
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
    const now = body.read(cell.x, state.request.y, cell.z);
    if (now !== null && state.facts.isTilledSoil(now)) countTilled();
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
    const seq = ++state.plantSeq;
    state.pendingPlants.delete(cellKey(cell));
    let failed: PlantFailure | null;
    try {
      failed = await body.plant(soilOf(state, cell), item);
    } catch (error) {
      const above = body.read(cell.x, state.request.y + 1, cell.z);
      if (above !== null && state.facts.isRipe(above) !== null) plantSucceeded(state, item, seq);
      throw error;
    }
    if (failed === null) {
      plantSucceeded(state, item, seq);
      return null;
    }
    if (failed.kind === "none carried") {
      why = `no ${item} left`;
      continue;
    }
    // An error or an unanswered use teaches nothing and tries no other item on this cell: only the server's answer does.
    if (failed.kind === "error") return `plant failed: ${failed.error}`;
    if (failed.kind === "unconfirmed") {
      state.pendingPlants.set(cellKey(cell), { item, seq, cell });
      return PLANT_NOT_CONFIRMED;
    }
    why = noteRefusal(a, item, cell, seq);
  }
  // Every item is off (a till cell was tilled before this): the cell is reported, never left with no reason.
  return why ?? (state.request.plant === null ? null : `${state.request.plant} cannot be planted`);
}

/** The server answered that `item` grew nothing at `cell`: at two different cells the item is off for the request. Returns the skip reason. */
function noteRefusal(a: TendAttempt, item: string, cell: TendCell, seq: number): string {
  reconcilePending(a);
  const { state } = a;
  const cells = state.refusedAt.get(item) ?? new Map<string, number>();
  state.refusedAt.set(item, cells.set(cellKey(cell), seq));
  if (cells.size < REFUSALS_TO_SWITCH_OFF) return DID_NOT_TAKE(item);
  state.unplantable.add(item);
  return `${item} cannot be planted`;
}

const NO_HOE_LEFT = "no hoe left";
const PLANT_NOT_CONFIRMED = "plant not confirmed (server behind)";
const DID_NOT_TAKE = (item: string) => `${item} did not take`;
/** The same answer at this many different cells: "a fact one bot learns for all needs repeated evidence" (`claude/rules/code-changes.md`). */
const REFUSALS_TO_SWITCH_OFF = 2;
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

/**
 * The crops standing on the plot's farmland by `<block> age <n>` (`ripe` appended when ripe), and the age each crop
 * block is ripe at. One reading for the plot before the tend and the plot after it, so their keys are the same.
 */
function cropsOf(request: TendCropsRequest, cells: readonly TendCell[], body: FarmBody, facts: PlotFacts): { crops: Record<string, number>; ripeAge: Record<string, number> } {
  const standing = { crops: {} as Record<string, number>, ripeAge: {} as Record<string, number> };
  for (const cell of cells) {
    const soil = body.read(cell.x, request.y, cell.z);
    const above = body.read(cell.x, request.y + 1, cell.z);
    if (soil === null || above === null || !facts.isTilledSoil(soil)) continue;
    const ripe = facts.isRipe(above);
    if (ripe === null) continue;
    const key = `${above.name} age ${String(above.properties.age)}${ripe ? " ripe" : ""}`;
    standing.crops[key] = (standing.crops[key] ?? 0) + 1;
    const ripeAge = facts.ripeAge(above.name);
    if (ripeAge !== null) standing.ripeAge[above.name] = ripeAge;
  }
  return standing;
}

/** The plot as it stands now: crops by block and age with their ripe ages, empty and dry farmland, water. */
function plotAfter(request: TendCropsRequest, cells: readonly TendCell[], body: FarmBody, facts: PlotFacts): TendEvidence["after"] {
  const after = { ...cropsOf(request, cells, body, facts), emptyFarmland: 0, dryFarmland: 0, water: 0 };
  for (const cell of cells) {
    const soil = body.read(cell.x, request.y, cell.z);
    const above = body.read(cell.x, request.y + 1, cell.z);
    if (soil === null || above === null) continue;
    if (soil.liquid) after.water += 1;
    if (!facts.isTilledSoil(soil)) continue;
    if (Number(soil.properties.moisture ?? 7) < 7) after.dryFarmland += 1;
    if (facts.isRipe(above) === null && !above.breakable) after.emptyFarmland += 1;
  }
  return after;
}
