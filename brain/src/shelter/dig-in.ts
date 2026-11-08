// The shelter flow: walk to a spot, dig the hole, step into it, roof it, wait inside for the day, climb out.
import { setTimeout as sleep } from "node:timers/promises";
import type { ActOutcome, Body } from "../body.ts";
import type { BlockKind, BotRuntime, BotSnapshot, Position, ProtectedArea } from "../runtime-client.ts";
import type { SkillResult } from "../skills.ts";
import { DEPTH, describeNoSpot, isInHole, roofBlock, shelterBox, shelterSpots, spotCells, type ShelterSpot, type SpotSearch } from "./spot.ts";

/**
 * The shelter flow of the skill `dig_shelter`: finds ground where a closed hole can be dug (`shelter/spot.ts`), walks
 * there, digs it three deep, steps into it when the bot's box rests on a neighbour and stays up, roofs it with a carried
 * block that stays put, waits inside for the day, then digs the roof and climbs out.
 *
 * The model calls it as `dig_shelter`; until P4-18 brings the night decision the night trigger in
 * `brain/src/agent/step-guards.ts` (`shelterIfNight`) calls it too, with the same flow.
 */

/** How often she looks at the sky while waiting. */
const WAIT_SLICE_MS = 15_000;
const MAX_RESUMES = 4;
// Unmeasured against evade distances; the live shelter run records them (plan T6).
const RETURN_RADIUS = 8;
/** The longest wait for the status to show her landed after a dig (a lagging client shows the fall late), and how often it is read. */
const LANDING_MS = 3_000;
const LANDING_POLL_MS = 100;
/** The most physics ticks she walks forward to drop into a hole her box rests over (the centre of the cell is at most 0.5 away). */
const STEP_IN_MAX_TICKS = 5;
// Game knowledge: walking is about 0.2 blocks a physics tick once going (Minecraft wiki "Walking": 4.317 blocks a
// second at 20 ticks a second is 0.216), less from rest: scenario `shelter/off-centre-drop-in` measured 0.25 blocks
// for 2 ticks. The ticks to the middle of the cell are rounded up; the box only has to come within 0.2 of the middle.
const WALK_BLOCKS_PER_TICK = 0.2;

const WHY = "Night is dangerous: I dig in and wait for the day.";

export interface ShelterTimings {
  /** The longest wait, on the monotonic clock, for the status to show her one cell lower after a dig. */
  readonly landingMs: number;
  readonly landingPollMs: number;
  /** How often she looks at the sky (and at where she is) while waiting. */
  readonly waitSliceMs: number;
  readonly minuteMs: number;
}

/** The hole as the memory and the monitor know it: the surface cell it is dug from, how deep, and whether it is roofed. */
export interface ShelterHole {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly depth: number;
  readonly roofed: boolean;
}

export interface ShelterContext {
  readonly runtime: BotRuntime;
  readonly body: Body;
  readonly signal: AbortSignal;
  readonly areas: readonly ProtectedArea[];
  /** True once the night is over (or there is no night where she is). */
  readonly dayCame: () => Promise<boolean>;
  /** Carried blocks the objective needs: never the roof. */
  readonly needed?: ReadonlySet<string>;
  /** Called while she waits, so a watchdog sees the step is alive (plan T3b). */
  readonly alive?: () => void;
  /** Called with the hole once the roof step is done (placed or not), never before it. */
  readonly onHole?: (hole: ShelterHole) => void;
  /** The waits' lengths; a test seam, the constants by default. */
  readonly timings?: Partial<ShelterTimings>;
  /** Monotonic clock for the shelter deadline; injectable for deterministic tests. */
  readonly now?: () => number;
}

export interface ShelterOptions {
  /** Minutes to stay sheltered, unless day comes first after starting at night. */
  readonly minutes?: number;
}

type ShelterAct = (tool: "navigate" | "raw_action", input: Record<string, unknown>) => Promise<ActOutcome>;
const isBusy = (outcome: ActOutcome) => outcome.status === "refused" && outcome.error?.includes("ACTION_BUSY") === true;

/** A hole dug at `spot`: `depth` cells deep, her feet in the lowest. */
interface Hole {
  readonly spot: ShelterSpot;
  readonly depth: number;
}

/** The roof of the hole: the carried block chosen, whether the server placed it, and how the final text says it. */
interface Roof {
  readonly block: string | null;
  readonly placed: boolean;
  readonly words: string;
}

const timingsOf = (context: ShelterContext): ShelterTimings => ({ landingMs: LANDING_MS, landingPollMs: LANDING_POLL_MS, waitSliceMs: WAIT_SLICE_MS, minuteMs: 60_000, ...context.timings });

const stopped: SkillResult = { status: "stopped" };
const cellOf = ({ x, y, z }: Position) => `${Math.floor(x)} ${Math.floor(y)} ${Math.floor(z)}`;

/** What the model can do from inside the hole. */
const leaveHint = (spot: ShelterSpot) => `go_to a spot on the surface nearby (${spot.x} ${spot.y} ${spot.z}) to get out`;

/** Where players and the nearest mobs stand, from the status: two bots never share a 1x1 hole. */
function occupantsOf(status: BotSnapshot): readonly Position[] {
  const players = status.players.flatMap((player) => (player.position === null ? [] : [player.position]));
  return [...players, ...status.mobs.flatMap((mob) => (mob.position === undefined ? [] : [mob.position]))];
}

/** Waits until the status shows her feet at `spot.y - depth` (the fall after a dig); false when it does not within the bound. */
async function awaitLanding(context: ShelterContext, spot: ShelterSpot, depth: number): Promise<boolean> {
  const { landingMs, landingPollMs } = timingsOf(context);
  const deadline = performance.now() + landingMs;
  for (;;) {
    if (Math.floor((await context.runtime.status()).position.y) <= spot.y - depth) return true;
    if (context.signal.aborted || performance.now() >= deadline) return false;
    await sleep(landingPollMs, undefined, { signal: context.signal }).catch(() => undefined);
  }
}

/**
 * Walks forward onto the middle of the dug cell: a bot whose centre is over the hole but whose box rests on the
 * neighbour does not fall by itself (scenarios `shelter/off-centre-stays-up` and `off-centre-drop-in`). Nothing to do
 * when she is already in the middle of the cell.
 */
async function stepIntoCell(context: ShelterContext, act: ShelterAct, spot: ShelterSpot): Promise<void> {
  const { position } = await context.runtime.status();
  const [toX, toZ] = [spot.x + 0.5 - position.x, spot.z + 0.5 - position.z];
  const ticks = Math.min(STEP_IN_MAX_TICKS, Math.ceil(Math.max(Math.abs(toX), Math.abs(toZ)) / WALK_BLOCKS_PER_TICK));
  if (ticks === 0) return;
  // `look` at a cell takes whole block coordinates (the runtime refuses 0.5), so the heading is given as angles: the
  // yaw mineflayer's `lookAt` computes for a point (`Math.atan2(-dx, -dz)`), level, since only the yaw steers `forward`.
  const looked = await act("raw_action", { operation: "look", yaw: Math.atan2(-toX, -toZ), pitch: 0 });
  // A refused look leaves the heading unknown: walking then could take her anywhere on the surface at night.
  if (context.signal.aborted || looked.status !== "succeeded") return;
  await act("raw_action", { operation: "control", state: "forward", ticks });
}

/**
 * The first cell dug: she drops in, or is walked in once when her box rests on the neighbour; a result when she does
 * not land, with nothing dug below (no hole to wait in yet, so the model is told at once).
 */
async function dropIntoFirstCell(context: ShelterContext, act: ShelterAct, spot: ShelterSpot): Promise<SkillResult | null> {
  if (await awaitLanding(context, spot, 1)) return null;
  if (context.signal.aborted) return stopped;
  await stepIntoCell(context, act, spot);
  if (context.signal.aborted) return stopped;
  if (await awaitLanding(context, spot, 1)) return null;
  if (context.signal.aborted) return stopped;
  const feet = cellOf((await context.runtime.status()).position);
  return { status: "failed", detail: `could not drop into the hole at ${spot.x} ${spot.y - 1} ${spot.z} (feet at ${feet}); go_to a spot a few blocks away and dig in there` };
}

/**
 * Digs down one cell at a time and waits for the fall after each (a cell already open is only waited for). The day
 * coming stops the digging at the depth reached. `landed` is whether she was seen on the lowest cell dug: below the
 * first cell an unseen fall is a late client (`LANDING_MS`), not a reason to leave the hole she is most likely in, so
 * the digging goes on and the roof is skipped.
 */
async function digIn(context: ShelterContext, act: ShelterAct, spot: ShelterSpot, startDepth: number): Promise<{ readonly depth: number; readonly landed: boolean; readonly failure?: ActOutcome } | SkillResult> {
  let landed = true;
  for (let depth = startDepth + 1; depth <= DEPTH; depth += 1) {
    if (await context.dayCame()) return { depth: depth - 1, landed };
    if (depth > spot.dug) {
      const dug = await act("raw_action", { operation: "dig", x: spot.x, y: spot.y - depth, z: spot.z });
      if (context.signal.aborted) return stopped;
      if (dug.status !== "succeeded") return { depth: depth - 1, landed, failure: dug };
    }
    if (depth === 1) {
      const unlanded = await dropIntoFirstCell(context, act, spot);
      if (unlanded !== null) return unlanded;
    } else {
      landed = await awaitLanding(context, spot, depth);
      if (context.signal.aborted) return stopped;
    }
  }
  return { depth: DEPTH, landed };
}

/** Places the carried block against the support, only when she was seen on the floor of the full-depth hole. */
async function roofHole(context: ShelterContext, act: ShelterAct, spot: ShelterSpot, kinds: Readonly<Record<string, BlockKind>>, dug: { readonly depth: number; readonly landed: boolean }): Promise<Roof> {
  const open = (why: string): Roof => ({ block: null, placed: false, words: `in an open hole (${why})` });
  if (dug.depth < DEPTH || !dug.landed) return open("the roof was not placed");
  const block = roofBlock((await context.runtime.status()).inventory, kinds, context.needed);
  if (block === null) return open("no carried block that stays put");
  const { support, face } = spot;
  const placed = await act("raw_action", { operation: "place", block_name: block, x: support.x, y: support.y, z: support.z, face });
  return placed.status === "succeeded" ? { block, placed: true, words: `in a hole roofed with ${block}` } : { ...open("the roof was not placed"), block };
}

/** Waits for the day, looking at where she is: `left` when she is no longer in the hole (a death, a reflex, a push). */
async function waitForDay(context: ShelterContext, spot: ShelterSpot): Promise<{ readonly outcome: "day"; readonly waitedMs: number } | { readonly outcome: "stopped"; readonly waitedMs: number } | { readonly outcome: "left"; readonly now: Position }> {
  const started = performance.now();
  for (;;) {
    if (context.signal.aborted) return { outcome: "stopped", waitedMs: performance.now() - started };
    const { position } = await context.runtime.status();
    if (!isInHole(position, spot)) return { outcome: "left", now: position };
    if (await context.dayCame()) return { outcome: "day", waitedMs: performance.now() - started };
    context.alive?.();
    await sleep(timingsOf(context).waitSliceMs, undefined, { signal: context.signal }).catch(() => undefined);
  }
}

/** Digs the roof when there is one, walks out; `done` only when the walk succeeded. */
async function climbOut(context: ShelterContext, act: ShelterAct, hole: Hole, roof: Roof, waitedMs: number): Promise<{ readonly result: SkillResult; readonly roofStill: boolean }> {
  const { spot, depth } = hole;
  const opened = roof.placed ? await act("raw_action", { operation: "dig", x: spot.x, y: spot.y - 1, z: spot.z }) : null;
  const roofStill = opened !== null && opened.status !== "succeeded";
  const out = opened !== null && isBusy(opened) ? opened : await act("navigate", { x: spot.x, y: spot.y, z: spot.z, range: 1 });
  const floor = `${spot.x} ${spot.y - depth} ${spot.z}`;
  if (out.status !== "succeeded") {
    const roofWords = roofStill ? "; its roof is still on" : "";
    const position = (await context.runtime.status()).position;
    const where = isInHole(position, spot) ? "I am still in my hole" : "I could not climb out";
    return { roofStill, result: { status: "failed", detail: `sheltered but ${where}: feet at ${cellOf(position)}${roofWords}: ${out.error ?? out.status}; ${leaveHint(spot)}` } };
  }
  return { roofStill, result: { status: "done", detail: `sheltered ${roof.words} at ${floor} for ${Math.round(waitedMs / 60_000)} min; climbed out` } };
}

/**
 * Why the spot's own cells cannot be trusted, read cell by cell: a waterlogged block (a stair, a slab) fills a wall
 * with water the per-name kinds of the box read cannot see, and an unloaded cell is unknown. Null when they are fine;
 * also null when the read itself failed: the dig's own results then tell what the hole is.
 */
async function cellFlaw(runtime: BotRuntime, spot: ShelterSpot): Promise<"open_walls" | "unknown_cells" | null> {
  const cells = await runtime.cellsAt(spotCells(spot)).catch(() => null);
  if (cells === null) return null;
  if (cells.some((cell) => !cell.loaded)) return "unknown_cells";
  return cells.some((cell) => cell.holdsWater) ? "open_walls" : null;
}

/** Walks to the hole's spot; the error when she could not, null when she stands on it. */
async function walkToSpot(context: ShelterContext, act: ShelterAct, spot: ShelterSpot): Promise<string | null> {
  const here = (await context.runtime.status()).position;
  if (Math.floor(here.x) === spot.x && Math.floor(here.z) === spot.z && Math.floor(here.y) === spot.y) return null;
  const moved = await act("navigate", { x: spot.x, y: spot.y, z: spot.z, range: 0 });
  return moved.status === "succeeded" ? null : `${moved.error ?? moved.status}`;
}

/**
 * The first candidate she can stand on: one whose cells read clean, then walked to; a failed walk tries the next.
 * A result when none could be (counting the ones dropped by the cell read in the no-spot text) or an order stopped her.
 */
async function reachASpot(context: ShelterContext, act: ShelterAct, search: SpotSearch): Promise<ShelterSpot | SkillResult> {
  const dropped = { open_walls: 0, unknown_cells: 0 };
  let walked = 0;
  let lastError = "";
  for (const spot of search.spots) {
    const flaw = await cellFlaw(context.runtime, spot);
    if (flaw !== null) { dropped[flaw] += 1; continue; }
    walked += 1;
    const error = await walkToSpot(context, act, spot);
    if (context.signal.aborted) return stopped;
    if (error === null) return spot;
    if (await context.dayCame()) return { status: "done", detail: "the shelter time ended before reaching a spot" };
    lastError = error;
  }
  if (walked > 0) return { status: "failed", detail: `could not reach any of ${walked} spots to dig in: ${lastError}; go_to another place and dig in there` };
  // The best spots are neighbours that share cells, so one flawed cell drops them all: say the other columns were not read.
  return { status: "failed", detail: `the ${search.spots.length} best spots each had water or an unloaded cell around their hole (${dropped.open_walls} with water, ${dropped.unknown_cells} unloaded); the other columns were not read: go_to another place and dig in there` };
}

interface ShelterProgress {
  spot: ShelterSpot;
  depth: number;
  landed: boolean;
  roof: Roof | null;
  readonly causes: string[];
}

/** Retry a busy body without treating the refusal as an interruption. */
function retryBusy(context: ShelterContext, act: ShelterAct): ShelterAct {
  return async (tool, input) => {
    for (;;) {
      if (context.signal.aborted) return { status: "cancelled", error: "stopped", preempted: false };
      const result = await act(tool, input);
      if (!isBusy(result)) return result;
      if (await context.dayCame()) return result;
      context.alive?.();
      await sleep(timingsOf(context).waitSliceMs, undefined, { signal: context.signal }).catch(() => undefined);
      if (await context.dayCame()) return result;
    }
  };
}

/** Find and reach a fresh shelter from the current position. */
async function findShelter(context: ShelterContext, act: ShelterAct): Promise<ShelterSpot | SkillResult> {
  const status = await context.runtime.status();
  const box = shelterBox(status.position);
  const search = shelterSpots(await context.runtime.blocksIn(box.min, box.max), status.position, context.areas, occupantsOf(status));
  return search.spots.length === 0 ? { status: "failed", detail: describeNoSpot(search) } : reachASpot(context, act, search);
}

type ResumeResult = "returned" | "search" | "end" | SkillResult;

/** Count interruptions, return to the reached floor, or search again after a distant displacement. */
async function resumeShelter(context: ShelterContext, act: ShelterAct, state: ShelterProgress, cause: string, what: string): Promise<ResumeResult> {
  for (;;) {
    if (context.signal.aborted) return stopped;
    const { position } = await context.runtime.status();
    if (state.causes.length >= MAX_RESUMES) {
      const hint = isInHole(position, state.spot) ? `; ${leaveHint(state.spot)}` : "; go_to another place and dig in there";
      return { status: "failed", detail: `${what}: ${cause}; gave up after ${MAX_RESUMES} resumes; now at ${cellOf(position)}${hint}` };
    }
    state.causes.push(cause.slice(0, 80));
    if (await context.dayCame()) return "end";
    const { spot, depth } = state;
    if (Math.hypot(position.x - (spot.x + 0.5), position.y - spot.y, position.z - (spot.z + 0.5)) > RETURN_RADIUS) return "search";
    const target = { x: spot.x, y: spot.y - depth, z: spot.z, range: 0 };
    if (Math.floor(position.x) === target.x && Math.floor(position.y) === target.y && Math.floor(position.z) === target.z) return "returned";
    if (context.signal.aborted) return stopped;
    const moved = await act("navigate", target);
    if (context.signal.aborted) return stopped;
    if (moved.status === "succeeded") return "returned";
    if (await context.dayCame()) return "end";
    what = "could not return to the hole"; cause = moved.error ?? moved.status;
  }
}

/** Replace a missing roof after a return, preserving a roof that remains in place. */
async function roofAfterReturn(context: ShelterContext, act: ShelterAct, state: ShelterProgress, kinds: Readonly<Record<string, BlockKind>>): Promise<Roof> {
  if (state.roof !== null && state.roof.placed) {
    const cell = (await context.runtime.cellsAt([{ x: state.spot.x, y: state.spot.y - 1, z: state.spot.z }]).catch(() => []))[0];
    if (cell === undefined || !cell.loaded) return state.roof;
    const kind = (await context.runtime.blockKinds([cell.name]))[cell.name];
    if (kind?.solid !== false) return state.roof;
  }
  return roofHole(context, act, state.spot, kinds, state);
}

/** Retry a failed climb once, preserving the first failure's roof and next-step detail. */
async function finishShelter(context: ShelterContext, act: ShelterAct, state: ShelterProgress, waitedMs: number): Promise<SkillResult> {
  const roof = state.roof ?? { block: null, placed: false, words: "in an open hole (the roof was not placed)" };
  let climbError = "climb failed";
  let busy = false;
  const recordClimb: ShelterAct = async (tool, input) => {
    const result = await act(tool, input);
    if (isBusy(result)) busy = true;
    if ((tool === "navigate" || busy) && result.status !== "succeeded") climbError = result.error ?? result.status;
    return result;
  };
  const first = await climbOut(context, recordClimb, state, roof, waitedMs);
  if (context.signal.aborted) return stopped;
  if (first.result.status !== "failed") return first.result;
  const position = (await context.runtime.status()).position;
  if (busy) return isInHole(position, state.spot) ? first.result : { status: "done", detail: `the shelter time ended; now at ${cellOf(position)}` };
  if (state.causes.length >= MAX_RESUMES) {
    return { status: "failed", detail: `${first.result.detail}; gave up after ${MAX_RESUMES} resumes; now at ${cellOf(position)}` };
  }
  state.causes.push(climbError.slice(0, 80));
  if (!isInHole(position, state.spot)) return { status: "done", detail: `the shelter time ended; now at ${cellOf(position)}` };
  context.alive?.();
  await sleep(timingsOf(context).waitSliceMs, undefined, { signal: context.signal }).catch(() => undefined);
  if (context.signal.aborted) return stopped;
  const second = await climbOut(context, act, state, { ...roof, placed: first.roofStill }, waitedMs);
  if (context.signal.aborted) return stopped;
  return second.result;
}

/** Run the shelter stages, retaining the dug depth and interruption causes across resumes. */
async function runShelter(context: ShelterContext, act: ShelterAct, rawAct: ShelterAct, kinds: Readonly<Record<string, BlockKind>>): Promise<SkillResult> {
  let spot = await findShelter(context, act);
  if ("status" in spot) return withResumes(spot, []);
  const state: ShelterProgress = { spot, depth: 0, landed: true, roof: null, causes: [] };
  let waitedMs = 0;
  for (;;) {
    const dug = await digIn(context, act, state.spot, state.depth);
    if ("status" in dug) return withResumes(dug, state.causes);
    state.depth = dug.depth; state.landed = dug.landed;
    let cause = dug.failure?.error ?? (dug.failure === undefined ? undefined : dug.failure.status);
    let what = `could not dig the hole at ${state.spot.x} ${state.spot.y - state.depth - 1} ${state.spot.z}`;
    if (dug.failure?.status === "refused" && cause?.includes("ACTION_BUSY") && await context.dayCame()) {
      const position = (await context.runtime.status()).position;
      const result = state.depth > 0 && isInHole(position, state.spot) ? await finishShelter(context, rawAct, state, waitedMs) : { status: "done" as const, detail: `the shelter time ended; now at ${cellOf(position)}` };
      return withResumes(result, state.causes);
    }
    if (cause === undefined && state.depth === 0) return withResumes({ status: "done", detail: "the day had come when I reached the spot: nothing dug" }, state.causes);
    if (cause === undefined) {
      state.roof = await roofAfterReturn(context, rawAct, state, kinds);
      if (context.signal.aborted) return stopped;
      context.onHole?.({ x: state.spot.x, y: state.spot.y, z: state.spot.z, depth: state.depth, roofed: state.roof.placed });
      const wait = await waitForDay(context, state.spot);
      if (wait.outcome === "stopped") return stopped;
      if (wait.outcome === "day") { waitedMs += wait.waitedMs; return withResumes(await finishShelter(context, rawAct, state, waitedMs), state.causes); }
      cause = `left the hole at ${cellOf(wait.now)}`;
      what = "could not stay in the hole";
    }
    const resumed = await resumeShelter(context, act, state, cause, what);
    if (typeof resumed !== "string") return withResumes(resumed, state.causes);
    if (resumed === "end") {
      const position = (await context.runtime.status()).position;
      const result = isInHole(position, state.spot) ? await finishShelter(context, rawAct, state, waitedMs) : { status: "done" as const, detail: "the day came" };
      return withResumes(result, state.causes);
    }
    if (resumed === "search") {
      spot = await findShelter(context, act);
      if ("status" in spot) return withResumes(spot, state.causes);
      state.spot = spot; state.depth = 0; state.landed = true; state.roof = null;
    }
  }
}

/** Append the bounded resume history to every completed result. */
function withResumes(result: SkillResult, causes: readonly string[]): SkillResult {
  if (result.status === "stopped") return result;
  return { ...result, detail: `${result.detail ?? ""}; resumes: ${causes.length}${causes.length ? ` (${causes.join("; ")})` : ""}` };
}

/** Digs, shelters until the requested end, and climbs out, resuming interruptions within a bound. */
export async function digShelterFlow(context: ShelterContext, options: ShelterOptions = {}): Promise<SkillResult> {
  if (context.signal.aborted) return stopped;
  const startedByDay = await context.dayCame();
  if (startedByDay && options.minutes === undefined) return withResumes({ status: "done", detail: "it is day: nothing to shelter from; give minutes to stay in a while" }, []);
  const now = context.now ?? (() => performance.now());
  const deadline = options.minutes === undefined ? Infinity : now() + options.minutes * timingsOf(context).minuteMs;
  const originalDayCame = context.dayCame;
  context = { ...context, dayCame: async () => now() >= deadline || (!startedByDay && await originalDayCame()) };
  const { runtime, body, signal } = context;
  const act: ShelterAct = (tool, input) => body.act(tool, input, WHY, { signal });
  const status = await runtime.status();
  const kinds = await runtime.blockKinds(status.inventory.map((stack) => stack.name));
  return runShelter(context, retryBusy(context, act), act, kinds);
}
