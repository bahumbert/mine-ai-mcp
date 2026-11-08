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
 * `brain/src/agent/step-guards.ts` (`shelterIfNight`) calls it too, with the same flow. `minutes` is accepted and not
 * used yet (plan 2026-11-07-p4-05a-shelter T3b).
 */

/** How often she looks at the sky while waiting. */
const WAIT_SLICE_MS = 15_000;
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
}

export interface ShelterOptions {
  /** Minutes to stay inside (plan T3b); unused until then. */
  readonly minutes?: number;
}

type ShelterAct = (tool: "navigate" | "raw_action", input: Record<string, unknown>) => Promise<ActOutcome>;

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

const timingsOf = (context: ShelterContext): ShelterTimings => ({ landingMs: LANDING_MS, landingPollMs: LANDING_POLL_MS, waitSliceMs: WAIT_SLICE_MS, ...context.timings });

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

/** The text of a dig that failed: the cell, the cause, the hole she is in, and where she was, so a log tells a bad fall from a reflex. */
async function digFailure(context: ShelterContext, spot: ShelterSpot, depth: number, dug: ActOutcome): Promise<SkillResult> {
  const feet = cellOf((await context.runtime.status()).position);
  const inHole = depth > 1 ? `; I am in a hole ${depth - 1} deep: ${leaveHint(spot)}` : "; go_to a spot a few blocks away and dig in there";
  return { status: "failed", detail: `could not dig the hole at ${spot.x} ${spot.y - depth} ${spot.z}: ${dug.error ?? dug.status}${inHole} (spot ${spot.x} ${spot.y} ${spot.z}, feet ${feet})` };
}

/**
 * Digs down one cell at a time and waits for the fall after each (a cell already open is only waited for). The day
 * coming stops the digging at the depth reached. `landed` is whether she was seen on the lowest cell dug: below the
 * first cell an unseen fall is a late client (`LANDING_MS`), not a reason to leave the hole she is most likely in, so
 * the digging goes on and the roof is skipped.
 */
async function digIn(context: ShelterContext, act: ShelterAct, spot: ShelterSpot): Promise<{ readonly depth: number; readonly landed: boolean } | SkillResult> {
  let landed = true;
  for (let depth = 1; depth <= DEPTH; depth += 1) {
    if (await context.dayCame()) return { depth: depth - 1, landed };
    if (depth > spot.dug) {
      const dug = await act("raw_action", { operation: "dig", x: spot.x, y: spot.y - depth, z: spot.z });
      if (context.signal.aborted) return stopped;
      if (dug.status !== "succeeded") return digFailure(context, spot, depth, dug);
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
async function waitForDay(context: ShelterContext, spot: ShelterSpot): Promise<{ readonly outcome: "day" | "stopped"; readonly waitedMs: number } | { readonly outcome: "left"; readonly now: Position }> {
  const started = performance.now();
  for (;;) {
    if (context.signal.aborted) return { outcome: "stopped", waitedMs: performance.now() - started };
    const { position } = await context.runtime.status();
    if (!isInHole(position, spot)) return { outcome: "left", now: position };
    if (await context.dayCame()) return { outcome: "day", waitedMs: performance.now() - started };
    await sleep(timingsOf(context).waitSliceMs, undefined, { signal: context.signal }).catch(() => undefined);
  }
}

/** Digs the roof when there is one, walks out; `done` only when the walk succeeded. */
async function climbOut(act: ShelterAct, hole: Hole, roof: Roof, waitedMs: number): Promise<SkillResult> {
  const { spot, depth } = hole;
  const opened = roof.placed ? await act("raw_action", { operation: "dig", x: spot.x, y: spot.y - 1, z: spot.z }) : null;
  const out = await act("navigate", { x: spot.x, y: spot.y, z: spot.z, range: 1 });
  const floor = `${spot.x} ${spot.y - depth} ${spot.z}`;
  if (out.status !== "succeeded") {
    const roofStill = opened !== null && opened.status !== "succeeded" ? "; its roof is still on" : "";
    return { status: "failed", detail: `waited out the night but I am still in my hole: feet at ${floor}${roofStill}: ${out.error ?? out.status}; ${leaveHint(spot)}` };
  }
  return { status: "done", detail: `waited out the night ${roof.words} at ${floor} for ${Math.round(waitedMs / 60_000)} min; climbed out` };
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
    lastError = error;
  }
  if (walked > 0) return { status: "failed", detail: `could not reach any of ${walked} spots to dig in: ${lastError}; go_to another place and dig in there` };
  // The best spots are neighbours that share cells, so one flawed cell drops them all: say the other columns were not read.
  return { status: "failed", detail: `the ${search.spots.length} best spots each had water or an unloaded cell around their hole (${dropped.open_walls} with water, ${dropped.unknown_cells} unloaded); the other columns were not read: go_to another place and dig in there` };
}

/**
 * Digs in, waits for the day, climbs out. `done` only when she is out of the hole (or never dug it because the day
 * had come). `failed` when no hole could be made (she then goes on as before), and also, with her still in the hole,
 * when a dig below the first failed or the climb out failed (the detail gives the floor and a next step); `failed`
 * with her elsewhere when she left the hole during the night. `stopped` wherever she is: the order that stopped her
 * leaves the hole by its own steps.
 */
export async function digShelterFlow(context: ShelterContext, _options: ShelterOptions = {}): Promise<SkillResult> {
  const { runtime, body, signal } = context;
  const act: ShelterAct = (tool, input) => body.act(tool, input, WHY, { signal });
  const status = await runtime.status();
  const kinds = await runtime.blockKinds(status.inventory.map((stack) => stack.name));
  const box = shelterBox(status.position);
  const search = shelterSpots(await runtime.blocksIn(box.min, box.max), status.position, context.areas, occupantsOf(status));
  if (search.spots.length === 0) return { status: "failed", detail: describeNoSpot(search) };
  const reached = await reachASpot(context, act, search);
  if ("status" in reached) return reached;
  const spot = reached;
  const dug = await digIn(context, act, spot);
  if ("status" in dug) return dug;
  if (dug.depth === 0) return { status: "done", detail: "the day had come when I reached the spot: nothing dug" };
  const roof = await roofHole(context, act, spot, kinds, dug);
  context.onHole?.({ x: spot.x, y: spot.y, z: spot.z, depth: dug.depth, roofed: roof.placed });
  const night = await waitForDay(context, spot);
  if (night.outcome === "stopped") return stopped;
  if (night.outcome === "left") {
    return { status: "failed", detail: `I am no longer in my hole (now at ${cellOf(night.now)}: a death, a reflex or a push); I did not climb out myself` };
  }
  const result = await climbOut(act, { spot, depth: dug.depth }, roof, night.waitedMs);
  return result.status === "failed" && signal.aborted ? stopped : result;
}
