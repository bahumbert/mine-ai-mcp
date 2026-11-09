// Shelter progress, roofing and the bounded return and climb after an interruption.
import { setTimeout as sleep } from "node:timers/promises";
import type { ActOutcome, Body } from "../body.ts";
import type { BotRuntime, Position, ProtectedArea } from "../runtime-client.ts";
import type { SkillResult } from "../skills.ts";
import { DEPTH, isInHole, roofBlock, type ShelterSpot } from "./spot.ts";

/** How often she looks at the sky while waiting. */
const WAIT_SLICE_MS = 15_000;
const MAX_RESUMES = 4;
// Unmeasured against evade distances; the live shelter run records them (plan T6).
const RETURN_RADIUS = 8;
/** The longest wait for the status to show her landed after a dig (a lagging client shows the fall late), and how often it is read. */
const LANDING_MS = 3_000;
const LANDING_POLL_MS = 100;

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

export type ShelterAct = (tool: "navigate" | "raw_action", input: Record<string, unknown>) => Promise<ActOutcome>;
/** Whether the runtime refused because a reflex still holds the body. */
export const isBusy = (outcome: ActOutcome) => outcome.status === "refused" && outcome.code === "ACTION_BUSY";

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

/** Shelter waits with the caller's timing overrides. */
export const timingsOf = (context: ShelterContext): ShelterTimings => ({ landingMs: LANDING_MS, landingPollMs: LANDING_POLL_MS, waitSliceMs: WAIT_SLICE_MS, minuteMs: 60_000, ...context.timings });

export const stopped: SkillResult = { status: "stopped" };
/** Whole block coordinates for the model's next action. */
export const cellOf = ({ x, y, z }: Position) => `${Math.floor(x)} ${Math.floor(y)} ${Math.floor(z)}`;

/** What the model can do from inside the hole. */
const leaveHint = (spot: ShelterSpot) => `go_to a spot on the surface nearby (${spot.x} ${spot.y} ${spot.z}) to get out`;

export interface ShelterProgress {
  spot: ShelterSpot;
  depth: number;
  landed: boolean;
  roof: Roof | null;
  readonly causes: string[];
}

/** Places the carried block against the support, only when she was seen on the floor of the full-depth hole. */
async function roofHole(context: ShelterContext, act: ShelterAct, spot: ShelterSpot, dug: { readonly depth: number; readonly landed: boolean }): Promise<Roof> {
  const open = (why: string): Roof => ({ block: null, placed: false, words: `in an open hole (${why})` });
  if (dug.depth < DEPTH || !dug.landed) return open("the roof was not placed");
  const { inventory } = await context.runtime.status();
  const kinds = await context.runtime.blockKinds(inventory.map((stack) => stack.name));
  const block = roofBlock(inventory, kinds, context.needed);
  if (block === null) return open("no carried block that stays put");
  const { support, face } = spot;
  const placed = await act("raw_action", { operation: "place", block_name: block, x: support.x, y: support.y, z: support.z, face });
  return placed.status === "succeeded" ? { block, placed: true, words: `in a hole roofed with ${block}` } : { ...open("the roof was not placed"), block };
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

/** Retry a busy body without treating the refusal as an interruption. */
export function retryBusy(context: ShelterContext, act: ShelterAct): ShelterAct {
  return async (tool, input) => {
    for (;;) {
      if (context.signal.aborted) return { status: "cancelled", error: "stopped", code: null, preempted: false };
      const result = await act(tool, input);
      if (!isBusy(result)) return result;
      if (await context.dayCame()) return result;
      context.alive?.();
      await sleep(timingsOf(context).waitSliceMs, undefined, { signal: context.signal }).catch(() => undefined);
      if (await context.dayCame()) return result;
    }
  };
}

type ResumeResult = "returned" | "search" | "end" | SkillResult;

/** Count interruptions, return to the reached floor, or search again after a distant displacement. */
export async function resumeShelter(context: ShelterContext, act: ShelterAct, state: ShelterProgress, cause: string, what: string): Promise<ResumeResult> {
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
export async function roofAfterReturn(context: ShelterContext, act: ShelterAct, state: ShelterProgress): Promise<Roof> {
  if (state.roof !== null && state.roof.placed) {
    const cell = (await context.runtime.cellsAt([{ x: state.spot.x, y: state.spot.y - 1, z: state.spot.z }]).catch(() => []))[0];
    if (cell === undefined || !cell.loaded) return state.roof;
    const kind = (await context.runtime.blockKinds([cell.name]))[cell.name];
    if (kind?.solid !== false) return state.roof;
  }
  return roofHole(context, act, state.spot, state);
}

/** Retry a failed climb once, preserving the first failure's roof and next-step detail. */
export async function finishShelter(context: ShelterContext, act: ShelterAct, state: ShelterProgress, waitedMs: number): Promise<SkillResult> {
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

/** Append the bounded resume history to every completed result. */
export function withResumes(result: SkillResult, causes: readonly string[]): SkillResult {
  if (result.status === "stopped") return result;
  return { ...result, detail: `${result.detail ?? ""}; resumes: ${causes.length}${causes.length ? ` (${causes.join("; ")})` : ""}` };
}
