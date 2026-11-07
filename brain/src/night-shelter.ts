import { setTimeout as sleep } from "node:timers/promises";
import type { ActOutcome, Body } from "./body.ts";
import type { BotRuntime, Position, ProtectedArea } from "./runtime-client.ts";
import { DEPTH, describeNoSpot, isInHole, roofBlock, shelterBox, shelterSpots, type ShelterSpot } from "./shelter/spot.ts";
import type { SkillResult } from "./skills.ts";

/**
 * TEMPORARY (owner, real-world session 2026-10-07: nights on his modded server are deadly; a quick measure until the
 * real night-awareness feature, backlog P1 "Night awareness"): at night she digs a hole three blocks deep where she
 * stands, roofs it with a carried block, waits there for the day, then digs the roof and climbs out. Code decides
 * this, not the model: a deliberate, temporary exception to Rule #0.
 */

/** How often she looks at the sky while waiting. */
const WAIT_SLICE_MS = 15_000;
/** The longest wait for the status to show her landed after a dig (a lagging client shows the fall late), and how often it is read. */
const LANDING_MS = 3_000;
const LANDING_POLL_MS = 100;

// The step guards still import `underCover` from here; plan 2026-11-07-p4-05a-shelter T4 moves them to spot.ts.
export { underCover } from "./shelter/spot.ts";

export interface ShelterContext {
  readonly runtime: BotRuntime;
  readonly body: Body;
  readonly signal: AbortSignal;
  readonly areas: readonly ProtectedArea[];
  /** True once the night is over (or there is no night where she is). */
  readonly dayCame: () => Promise<boolean>;
  /** The waits' lengths; a test seam, the constants by default. */
  readonly timings?: Partial<ShelterTimings>;
}

/** The lengths of the shelter's waits, in milliseconds. */
export interface ShelterTimings {
  /** The longest wait, on the monotonic clock, for the status to show her one cell lower after a dig. */
  readonly landingMs: number;
  readonly landingPollMs: number;
  /** How often she looks at the sky (and at where she is) while waiting. */
  readonly waitSliceMs: number;
}

const WHY = "Night is dangerous: I dig in and wait for the day.";

type ShelterAct = (tool: "navigate" | "raw_action", input: Record<string, unknown>) => Promise<ActOutcome>;

/** A hole dug at `spot`: `depth` cells deep, her feet in the lowest. */
interface Hole {
  readonly spot: ShelterSpot;
  readonly depth: number;
}

/** The roof of the hole: the carried block chosen, and whether the server placed it. */
interface Roof {
  readonly block: string | null;
  readonly placed: boolean;
}

const timingsOf = (context: ShelterContext): ShelterTimings => ({ landingMs: LANDING_MS, landingPollMs: LANDING_POLL_MS, waitSliceMs: WAIT_SLICE_MS, ...context.timings });

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
 * Digs down one cell at a time and waits for the fall after each. The day coming stops the digging at the depth
 * reached; `landed` is whether she was seen on the lowest cell dug.
 */
async function digIn(context: ShelterContext, act: ShelterAct, spot: ShelterSpot): Promise<{ readonly depth: number; readonly landed: boolean } | SkillResult> {
  let landed = true;
  for (let depth = 1; depth <= DEPTH; depth += 1) {
    if (await context.dayCame()) return { depth: depth - 1, landed };
    const dug = await act("raw_action", { operation: "dig", x: spot.x, y: spot.y - depth, z: spot.z });
    if (context.signal.aborted) return { status: "stopped" };
    if (dug.status !== "succeeded") return { status: "failed", detail: `could not dig the hole at ${spot.x} ${spot.y - depth} ${spot.z}: ${dug.error ?? dug.status}${depth > 1 ? `; I am in a hole ${depth - 1} deep: ${leaveHint(spot)}` : ""}` };
    landed = await awaitLanding(context, spot, depth);
    if (context.signal.aborted) return { status: "stopped" };
  }
  return { depth: DEPTH, landed };
}

/** What the model can do from inside the hole. */
const leaveHint = (spot: ShelterSpot) => `go_to a spot on the surface nearby (${spot.x} ${spot.y} ${spot.z}) to get out`;

/** Places the carried block against the support, only when she stands on the floor of the full-depth hole. */
async function roofHole(context: ShelterContext, act: ShelterAct, spot: ShelterSpot, landed: boolean): Promise<Roof> {
  const inventory = landed ? (await context.runtime.status()).inventory : [];
  const block = roofBlock(inventory, await context.runtime.blockKinds(inventory.map((stack) => stack.name)));
  if (block === null) return { block: null, placed: false };
  const { support, face } = spot;
  const placed = await act("raw_action", { operation: "place", block_name: block, x: support.x, y: support.y, z: support.z, face });
  return { block, placed: placed.status === "succeeded" };
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
  const how = roof.placed ? `in a hole roofed with ${roof.block}` : "in an open hole (the roof was not placed)";
  return { status: "done", detail: `waited out the night ${how} at ${floor} for ${Math.round(waitedMs / 60_000)} min; climbed out` };
}

/** Walks to the hole's spot; a result when she could not (or was stopped on the way), null when she stands on it. */
async function walkToSpot(context: ShelterContext, act: ShelterAct, spot: ShelterSpot): Promise<SkillResult | null> {
  const here = (await context.runtime.status()).position;
  if (Math.floor(here.x) === spot.x && Math.floor(here.z) === spot.z && Math.floor(here.y) === spot.y) return null;
  const moved = await act("navigate", { x: spot.x, y: spot.y, z: spot.z, range: 0 });
  if (context.signal.aborted) return { status: "stopped" };
  return moved.status === "succeeded" ? null : { status: "failed", detail: `could not reach ${spot.x} ${spot.y} ${spot.z} to dig in: ${moved.error ?? moved.status}` };
}

/**
 * Digs in, waits for the day, climbs out. `done` only when she is out of the hole (or never dug it because the day
 * had come). `failed` when no hole could be made (she then goes on as before), and also, with her still in the hole,
 * when a dig below the first failed or the climb out failed (the detail gives the floor and a next step); `failed`
 * with her elsewhere when she left the hole during the night. `stopped` wherever she is: the order that stopped her
 * leaves the hole by its own steps.
 */
export async function shelterForNight(context: ShelterContext): Promise<SkillResult> {
  const { runtime, body, signal } = context;
  const act: ShelterAct = (tool, input) => body.act(tool, input, WHY, { signal });
  const status = await runtime.status();
  const start = status.position;
  const box = shelterBox(start);
  const occupants = [...status.players, ...status.mobs].flatMap((one) => (one.position === null || one.position === undefined ? [] : [one.position]));
  const search = shelterSpots(await runtime.blocksIn(box.min, box.max), start, context.areas, occupants);
  const spot = search.spots[0];
  if (spot === undefined) return { status: "failed", detail: describeNoSpot(search) };
  const unreachable = await walkToSpot(context, act, spot);
  if (unreachable !== null) return unreachable;
  const dug = await digIn(context, act, spot);
  if ("status" in dug) return dug;
  if (dug.depth === 0) return { status: "done", detail: "the day had come when I reached the spot: nothing dug" };
  const roof = await roofHole(context, act, spot, dug.landed && dug.depth === DEPTH);
  const night = await waitForDay(context, spot);
  if (night.outcome === "stopped") return { status: "stopped" };
  if (night.outcome === "left") {
    const { x, y, z } = night.now;
    return { status: "failed", detail: `I am no longer in my hole (now at ${Math.floor(x)} ${Math.floor(y)} ${Math.floor(z)}: a death, a reflex or a push); I did not climb out myself` };
  }
  const result = await climbOut(act, { spot, depth: dug.depth }, roof, night.waitedMs);
  return result.status === "failed" && signal.aborted ? { status: "stopped" } : result;
}
