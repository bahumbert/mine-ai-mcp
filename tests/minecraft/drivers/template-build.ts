import { setTimeout as delay } from "node:timers/promises";
import { Vec3 } from "vec3";
import { z } from "zod";
import type { ClientCompletion } from "mine-labs/client";
import { builtBefore } from "#brain/building/build-audit.ts";
import { FACINGS, type WorldCell } from "#brain/building/blueprint.ts";
import { planTemplate, type HousePlan } from "#brain/building/plan.ts";
import { templateFor } from "#brain/building/templates.ts";
import type { ArenaFrame } from "../arena/frame.ts";
import { arenaCell } from "../arena/params.ts";
import type { ScenarioCall, ScenarioContext } from "../scenario.ts";

const paramsIn = (arena: ArenaFrame) => z.strictObject({
  /** A template id of `brain/building-templates/`. */
  template: z.string().min(1),
  /** The door's lower cell (feet height): the house stands behind it, facing `facing`, in front of the actor. */
  door: arenaCell(arena),
  facing: z.enum(FACINGS).default("north"),
  /** Cut the build short: calls 0..n are sent whole, call n + 1 is cancelled `cancelAfterMs` after it starts, then every call is sent again from the first. */
  interruptAfterBatch: z.number().int().nonnegative().optional(),
  /** The stage the cancelled call must belong to (a template edit that moves the call out of it fails the scenario instead of testing another stage). */
  interruptStage: z.string().min(1).optional(),
  cancelAfterMs: z.number().int().nonnegative().default(3_000),
});

/** `view_blocks` reads at most this many cells per call (`MAX_CELLS`, src/actions/view-blocks/contract.ts). */
const CELLS_PER_READ = 32;

/** What a `build_structure` answer says of its audit; every field is read only when present (a cancelled call may carry none). */
const answerSchema = z.object({
  structure: z.object({
    cells: z.number(), correct: z.number(), placed: z.number(), wrong: z.number(), passes: z.number(), complete: z.boolean(),
    scaffold: z.object({ leftCount: z.number() }).optional(),
  }).nullable().optional(),
});

const observedSchema = z.object({ blocks: z.object({ cells: z.array(z.object({ x: z.number(), y: z.number(), z: z.number(), name: z.string() })) }) });

class Failed extends Error {}

const keyOf = ({ x, y, z }: { readonly x: number; readonly y: number; readonly z: number }) => `${x},${y},${z}`;

interface PartInput {
  readonly blocks: readonly Record<string, unknown>[];
  readonly keep: readonly { x: number; y: number; z: number }[];
}

/**
 * What `buildParts` (brain/src/skills.ts) sends for each call: only the cells whose last call this is (a doorway is air
 * early and the door last; a door claims the cell above it), `keep` = every non-air cell of earlier calls. A call with
 * no such cell is null.
 */
function partInputs(plan: HousePlan): (PartInput | null)[] {
  const lastPart = new Map<string, number>();
  plan.batches.forEach((batch, part) => batch.forEach((cell) => {
    lastPart.set(keyOf(cell), part);
    if (cell.block.endsWith("_door")) lastPart.set(keyOf({ x: cell.x, y: cell.y + 1, z: cell.z }), part);
  }));
  return plan.batches.map((batch, part) => {
    const blocks = batch.filter((cell) => lastPart.get(keyOf(cell)) === part).map(({ x, y, z, block, facing, half, axis }) => ({
      x, y, z, block_name: block,
      ...(facing !== undefined && { facing }),
      ...(half !== undefined && { half }),
      ...(axis !== undefined && { axis }),
    }));
    return blocks.length === 0 ? null : { blocks, keep: builtBefore(plan.batches, part, lastPart) };
  });
}

const buildInput = (part: PartInput, auditing: boolean) => ({
  blocks: part.blocks, remove_wrong_blocks: true, ...(!auditing && part.keep.length > 0 && { keep: part.keep }),
});

function structureOf(call: ScenarioCall): z.output<typeof answerSchema>["structure"] {
  return answerSchema.safeParse(call.result).data?.structure;
}

/** Every call of the plan in order, each sent whole; the second pass (`auditing`) is the final check, with no `keep`. */
async function sendAll(context: ScenarioContext, inputs: readonly (PartInput | null)[], auditing: boolean, label: string): Promise<{ passes: number; scaffold: string[]; slowestMs: number }> {
  let passes = 0;
  let slowestMs = 0;
  const scaffold: string[] = [];
  for (const [index, part] of inputs.entries()) {
    if (part === null) continue;
    const history = watchCells(context, part);
    const call = await context.call("build_structure", buildInput(part, auditing)).finally(history.stop);
    if (call.result.status !== "succeeded") throw new Failed(`${label} call ${index + 1}/${inputs.length} read ${call.result.status}: ${call.summary}; carrying ${carried(context)}; now holding ${holdings(context, part)}; history ${history.events.join(" | ")}`);
    const structure = structureOf(call);
    if (structure?.complete === false) throw new Failed(`${label} call ${index + 1}/${inputs.length} succeeded with an incomplete audit: ${call.summary}`);
    passes = Math.max(passes, structure?.passes ?? 0);
    slowestMs = Math.max(slowestMs, call.durationMs);
    if ((structure?.scaffold?.leftCount ?? 0) > 0) scaffold.push(`${label} call ${index + 1}: ${structure?.scaffold?.leftCount} left`);
  }
  return { passes, scaffold, slowestMs };
}

/** What stands in the cells of a failed call that do not hold what the call asked (name and states, as the client's world has them). */
function holdings(context: ScenarioContext, part: PartInput): string {
  const lines = part.blocks.flatMap((cell) => {
    const block = context.bot.blockAt(new Vec3(Number(cell.x), Number(cell.y), Number(cell.z)));
    return block?.name === cell.block_name && part.blocks.length > 4 ? [] : [`${keyOf({ x: Number(cell.x), y: Number(cell.y), z: Number(cell.z) })} ${block?.name ?? "unloaded"} ${JSON.stringify(block?.getProperties() ?? {})} (asked ${String(cell.block_name)})`];
  });
  return lines.slice(0, 6).join("; ") || "nothing wrong by name";
}

/** The block changes of the cells of a small call (at most four: a door and its support), in order: how a cell was set and unset shows in a red run. */
function watchCells(context: ScenarioContext, part: PartInput): { events: string[]; stop: () => void } {
  const events: string[] = [];
  const listeners: [string, (...args: never[]) => void][] = [];
  if (part.blocks.length <= 4) {
    const started = performance.now();
    for (const cell of part.blocks) {
      const position = new Vec3(Number(cell.x), Number(cell.y), Number(cell.z));
      const event = `blockUpdate:(${position.x}, ${position.y}, ${position.z})`;
      const listener = (_old: unknown, next: { name: string; getProperties(): unknown } | null) => void events.push(`+${Math.round(performance.now() - started)}ms ${keyOf(position)} ${next?.name} ${JSON.stringify(next?.getProperties())}`);
      context.bot.on(event as never, listener as never);
      listeners.push([event, listener as never]);
    }
  }
  return { events, stop: () => listeners.forEach(([event, listener]) => context.bot.off(event as never, listener as never)) };
}

/** What the bot carries, for a failure that names a block it lacks. */
function carried(context: ScenarioContext): string {
  return context.bot.inventory.items().map((item) => `${item.count} ${item.name}`).join(", ");
}

/** The first call after call `after` that sends cells, or -1. */
const callAfter = (inputs: readonly (PartInput | null)[], after: number): number => inputs.findIndex((part, at) => at > after && part !== null);

/** The name of the plan's stage the cut call (the one after call `after`) belongs to: what a scenario's `interruptStage` names. */
export function stageOfCutCall(plan: HousePlan, after: number): string | undefined {
  const index = callAfter(partInputs(plan), after);
  return plan.stages.find((stage) => index >= stage.first && index <= stage.last)?.name;
}

/** Starts the call after `after`, cancels it `cancelAfterMs` later and checks it stopped midway: some of its cells stand, some do not. */
async function interruptNext(context: ScenarioContext, plan: HousePlan, inputs: readonly (PartInput | null)[], after: number, cancelAfterMs: number): Promise<string> {
  const index = callAfter(inputs, after);
  if (index === -1) throw new Failed(`interruptAfterBatch ${after}: no call follows it (${plan.batches.length} calls)`);
  const next = inputs[index]!;
  const pending = context.call("build_structure", buildInput(next, false));
  pending.catch(() => undefined);
  await delay(cancelAfterMs);
  const cancel = await context.call("cancel_foreground_action", { reason: "scenario: the house build is cut short" });
  const cancelled = await pending;
  if (cancelled.result.status !== "cancelled") {
    throw new Failed(`call ${index + 1} read ${cancelled.result.status}, not cancelled, ${cancelAfterMs} ms after its start (it was done before the cancel: pick a later call or a shorter wait): ${cancelled.summary}; cancel: ${cancel.summary}`);
  }
  // The cells this call is the last to send (what it must leave standing), by name.
  const standing = next.blocks.filter((cell) => context.bot.blockAt(new Vec3(Number(cell.x), Number(cell.y), Number(cell.z)))?.name === cell.block_name).length;
  const unplaced = next.blocks.length - standing;
  if (unplaced === 0) throw new Failed(`call ${index + 1} was cancelled but every cell of it stands: the cancel came after the work (${cancelled.summary})`);
  if (standing === 0) throw new Failed(`call ${index + 1} was cancelled before it placed a cell (${cancelAfterMs} ms): the cut is not midway, raise cancelAfterMs (${cancelled.summary})`);
  return `call ${index + 1}/${plan.batches.length} cancelled midway, ${standing} cells placed and ${unplaced} not`;
}

/** The cells to read: every cell of the plan, the ring of one around the footprint and the layer above the roof, from the door's level up. */
function boxCells(plan: HousePlan): { x: number; y: number; z: number }[] {
  const xs = plan.cells.map((cell) => cell.x);
  const ys = plan.cells.map((cell) => cell.y);
  const zs = plan.cells.map((cell) => cell.z);
  const cells: { x: number; y: number; z: number }[] = [];
  for (let y = Math.min(...ys); y <= Math.max(...ys) + 1; y += 1) {
    for (let z = Math.min(...zs) - 1; z <= Math.max(...zs) + 1; z += 1) {
      for (let x = Math.min(...xs) - 1; x <= Math.max(...xs) + 1; x += 1) if (y >= plan.site.door.y || plan.cells.some((cell) => cell.x === x && cell.y === y && cell.z === z)) cells.push({ x, y, z });
    }
  }
  return cells;
}

/** The block each cell must hold: the plan's (the door's upper half too); every other cell of the box is air, so no scaffold or carried dirt stays. */
function expectedBlocks(plan: HousePlan): Map<string, WorldCell> {
  const expected = new Map<string, WorldCell>();
  for (const cell of plan.cells) expected.set(keyOf(cell), cell);
  // The doorway above the door is listed as air in an early call and the door fills it: set after, so the door wins.
  for (const cell of plan.cells) if (cell.block.endsWith("_door")) expected.set(keyOf({ x: cell.x, y: cell.y + 1, z: cell.z }), { ...cell, y: cell.y + 1 });
  return expected;
}

async function readBox(context: ScenarioContext, plan: HousePlan): Promise<string[]> {
  const expected = expectedBlocks(plan);
  const cells = boxCells(plan);
  const wrong: string[] = [];
  for (let from = 0; from < cells.length; from += CELLS_PER_READ) {
    const read = await context.call("view_blocks", { cells: cells.slice(from, from + CELLS_PER_READ) });
    if (read.result.status !== "succeeded") throw new Failed(`view_blocks read ${read.result.status}: ${read.summary}`);
    for (const seen of observedSchema.parse(read.result).blocks.cells) {
      const cell = expected.get(keyOf(seen));
      const wanted = cell === undefined || cell.role === "air" ? "air" : cell.block;
      const isAir = seen.name === "air" || seen.name === "cave_air" || seen.name === "void_air";
      if (wanted === "air" ? !isAir : seen.name !== wanted) wrong.push(`${seen.x},${seen.y},${seen.z} holds ${seen.name}, wants ${wanted}`);
      else if (cell !== undefined && cell.role !== "air") wrong.push(...wrongStates(context, cell));
    }
  }
  return wrong;
}

/** The states the cell asks (facing, half, axis) as the server holds them: the audit's rule (`holdsCell`), read from the client's world. */
function wrongStates(context: ScenarioContext, cell: WorldCell): string[] {
  if (cell.facing === undefined && cell.half === undefined && cell.axis === undefined) return [];
  const block = context.bot.blockAt(new Vec3(cell.x, cell.y, cell.z));
  if (block === null) return [`${keyOf(cell)} is not loaded`];
  const properties = block.getProperties() as Readonly<Record<string, unknown>>;
  const half = properties.half ?? properties.type;
  return [
    cell.facing !== undefined && properties.facing !== cell.facing ? `${keyOf(cell)} ${cell.block} faces ${String(properties.facing)}, wants ${cell.facing}` : null,
    cell.half !== undefined && half !== cell.half ? `${keyOf(cell)} ${cell.block} is ${String(half)}, wants ${cell.half}` : null,
    cell.axis !== undefined && properties.axis !== cell.axis ? `${keyOf(cell)} ${cell.block} lies along ${String(properties.axis)}, wants ${cell.axis}` : null,
  ].filter((problem): problem is string => problem !== null);
}

const seconds = (since: number) => ((performance.now() - since) / 1000).toFixed(1);

/**
 * Builds one house template call by call, as `build` does (`buildParts`), then reads every cell: the support rules of
 * the engine (support.ts) against the real placement rules, which no unit test can show. With `interruptAfterBatch` a
 * call is cancelled mid-way and the whole plan is sent again, as a resumed build does. Nothing is asserted from a
 * result's wording: the cells are read back, the audit's status and its scaffold count are checked.
 */
export async function run(context: ScenarioContext): Promise<ClientCompletion> {
  const params = paramsIn(context.arena).parse(context.scenario.params);
  const template = templateFor(params.template);
  if (template === undefined) return { status: "failed", detail: `no template ${params.template}` };
  const plan = planTemplate(template, { door: params.door, facing: params.facing });
  const inputs = partInputs(plan);
  const started = performance.now();
  const notes: string[] = [];
  try {
    if (params.interruptAfterBatch !== undefined) {
      const stage = stageOfCutCall(plan, params.interruptAfterBatch);
      if (params.interruptStage !== undefined && stage !== params.interruptStage) throw new Failed(`the cut call is in stage "${stage}", not "${params.interruptStage}": move interruptAfterBatch`);
      await sendAll(context, inputs.slice(0, params.interruptAfterBatch + 1), false, "before the cut");
      notes.push(await interruptNext(context, plan, inputs, params.interruptAfterBatch, params.cancelAfterMs));
    }
    const first = await sendAll(context, inputs, false, "build");
    const final = await sendAll(context, inputs, true, "final check");
    const wrong = await readBox(context, plan);
    const scaffold = [...first.scaffold, ...final.scaffold];
    if (wrong.length > 0) throw new Failed(`${wrong.length} of the box's cells are wrong after the build: ${wrong.slice(0, 8).join("; ")}; scaffold the audits reported: ${scaffold.join(", ") || "none"}`);
    if (scaffold.length > 0) throw new Failed(`scaffold stands after the build: ${scaffold.join(", ")}`);
    notes.push(`${plan.cells.length} cells in ${plan.batches.length} calls, ${plan.stages.length} stages, all read right`);
    return { status: "succeeded", detail: `${template.id} (${params.facing}): ${notes.join("; ")} in ${seconds(started)} s (${first.passes} passes, final check ${final.passes}; slowest call ${Math.max(first.slowestMs, final.slowestMs)} ms)` };
  } catch (error) {
    if (!(error instanceof Failed)) throw error;
    return { status: "failed", detail: `${template.id} after ${seconds(started)} s: ${[...notes, error.message].join("; ")}` };
  }
}
