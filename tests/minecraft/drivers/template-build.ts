import { setTimeout as delay } from "node:timers/promises";
import { Vec3 } from "vec3";
import { z } from "zod";
import type { ClientCompletion } from "mine-labs/client";
import { builtBefore } from "#brain/skills/house-parts.ts";
import { FACINGS, type WorldCell } from "#brain/building/blueprint.ts";
import { planTemplate, type HousePlan } from "#brain/building/plan.ts";
import { callWorks, scaffoldNeed, scaffoldReserve, stageCells, type ScaffoldNeed } from "#brain/building/stage-progress.ts";
import { templateFor, type Stage } from "#brain/building/templates.ts";
import type { ItemCount } from "#brain/runtime-client.ts";
import { DEFAULT_SCAFFOLD_BLOCKS } from "#src/survival/policy/contract.ts";
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
  /** The scenario carries the bill and no block to stand on: the first stage the brain's reach rule flags must stop with "no scaffold block carried to stand on" (every stage before it builds whole). */
  expectScaffoldStop: z.boolean().default(false),
  /**
   * The scenario carries exactly this many dirt for the roof's scaffold (0: none, for a roof the eye reaches from the ground): the
   * run first checks it equals the brain's count (`scaffoldNeed`) for the first stage the reach rule flags (0 when it flags none),
   * then builds the whole template (the measure of that count at that height), with the policy's scaffold list as `build` leaves it
   * (`scaffoldListKeepingBill`) and the calls of stages that need none of their own sending the later stages' blocks as
   * `reserve_items` (`stageReserves`).
   */
  scaffoldCarried: z.number().int().nonnegative().optional(),
});

/** `view_blocks` reads at most this many cells per call (`MAX_CELLS`, src/actions/view-blocks/contract.ts). */
const CELLS_PER_READ = 32;

/** What a `build_structure` answer says of its audit; every field is read only when present (a cancelled call may carry none). */
const answerSchema = z.object({
  structure: z.object({
    cells: z.number(), correct: z.number(), placed: z.number(), wrong: z.number(), passes: z.number(), complete: z.boolean(),
    scaffold: z.object({ placed: z.number(), leftCount: z.number() }).optional(),
  }).nullable().optional(),
});

const observedSchema = z.object({ blocks: z.object({ cells: z.array(z.object({ x: z.number(), y: z.number(), z: z.number(), name: z.string() })) }) });

class Failed extends Error {}

const keyOf = ({ x, y, z }: { readonly x: number; readonly y: number; readonly z: number }) => `${x},${y},${z}`;

export interface PartInput {
  readonly blocks: readonly Record<string, unknown>[];
  readonly keep: readonly { x: number; y: number; z: number }[];
  /** `reserve_items` of the first pass: the scaffold a later stage stands on, kept by count (empty: none sent). */
  readonly reserve: readonly ItemCount[];
}

/**
 * What the brain's `buildStages` (brain/src/skills.ts) sends each stage as `reserve_items`, per stage: a stage that needs none
 * of its own (no reserve of its cells) and is not the last keeps what the cells of the later stages need to stand on
 * (`scaffoldReserve` over the stages after it, from none carried, with the scaffold list `build` leaves and the bill kept);
 * a stage with its own need, or the last, sends none.
 */
export function stageReserves(plan: HousePlan): ItemCount[][] {
  const kept = plan.bill.map((entry) => entry.item);
  const list = scaffoldListKeepingBill(plan);
  const reserveOf = (range: { readonly first: number; readonly last: number }) => scaffoldReserve(callWorks(plan, range, stageCells(plan, range)), plan.site.door.y, list, kept);
  return plan.stages.map((stage, index) => {
    if (index === plan.stages.length - 1 || reserveOf(stage).length > 0) return [];
    return reserveOf({ first: plan.stages[index + 1]!.first, last: plan.stages.at(-1)!.last });
  });
}

/**
 * What `buildParts` (brain/src/skills.ts) sends for each call: only the cells whose last call this is (a doorway is air
 * early and the door last; a door claims the cell above it), `keep` = every non-air cell of earlier calls, `reserve` =
 * its stage's (`stageReserves`) when `reserved`. A call with no such cell is null.
 */
export function partInputs(plan: HousePlan, reserved: boolean): (PartInput | null)[] {
  const reserves = reserved ? stageReserves(plan) : [];
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
    const stage = plan.stages.findIndex((entry) => part >= entry.first && part <= entry.last);
    return blocks.length === 0 ? null : { blocks, keep: builtBefore(plan.batches, part, lastPart), reserve: reserves[stage] ?? [] };
  });
}

/** The `build_structure` input of a call; the audit pass (`auditing`) sends no `keep` and no reserve, as the brain's does. */
export const buildInput = (part: PartInput, auditing: boolean) => ({
  blocks: part.blocks, remove_wrong_blocks: true,
  ...(!auditing && part.keep.length > 0 && { keep: part.keep }),
  ...(!auditing && part.reserve.length > 0 && { reserve_items: part.reserve }),
});

function structureOf(call: ScenarioCall): z.output<typeof answerSchema>["structure"] {
  return answerSchema.safeParse(call.result).data?.structure;
}

/** One `build_structure` call, with the history of its cells (a small call's) kept in `history.events` and the highest the bot's feet were during it. */
async function sendCall(context: ScenarioContext, part: PartInput, auditing: boolean): Promise<{ call: ScenarioCall; history: { events: string[] }; highestFeetY: number }> {
  const history = watchCells(context, part);
  let highestFeetY = context.bot.entity.position.y;
  const onMove = () => { highestFeetY = Math.max(highestFeetY, context.bot.entity.position.y); };
  context.bot.on("move", onMove);
  const call = await context.call("build_structure", buildInput(part, auditing)).finally(() => { history.stop(); context.bot.off("move", onMove); });
  return { call, history, highestFeetY };
}

/** What a call's audit says of the scaffold the routes laid for it: "3 scaffold placed" (the measure of the roof's stand-on need), "0 scaffold placed" when it reports none. */
const scaffoldPlaced = (call: ScenarioCall): string => `${structureOf(call)?.scaffold?.placed ?? 0} scaffold placed`;

/** Every call of the plan in order, each sent whole; the second pass (`auditing`) is the final check, with no `keep`. */
async function sendAll(context: ScenarioContext, inputs: readonly (PartInput | null)[], auditing: boolean, label: string): Promise<{ passes: number; scaffold: string[]; placed: string[]; slowestMs: number }> {
  let passes = 0;
  let slowestMs = 0;
  const scaffold: string[] = [];
  const placed: string[] = [];
  const trail: string[] = [];
  for (const [index, part] of inputs.entries()) {
    if (part === null) continue;
    const { call, history } = await sendCall(context, part, auditing);
    if (call.result.status !== "succeeded") throw new Failed(`${label} call ${index + 1}/${inputs.length} read ${call.result.status}: ${call.summary}; carrying ${carried(context)}; now holding ${holdings(context, part)}; history ${history.events.join(" | ")}; scaffold trail (after each call: placed, left standing, admitted blocks carried) ${trail.join(" | ") || "none"}`);
    trail.push(`${index + 1}: ${scaffoldPlaced(call)}, ${structureOf(call)?.scaffold?.leftCount ?? 0} left standing, ${admittedCarried(context)}`);
    const structure = structureOf(call);
    if (structure?.complete === false) throw new Failed(`${label} call ${index + 1}/${inputs.length} succeeded with an incomplete audit: ${call.summary}`);
    passes = Math.max(passes, structure?.passes ?? 0);
    slowestMs = Math.max(slowestMs, call.durationMs);
    if ((structure?.scaffold?.leftCount ?? 0) > 0) scaffold.push(`${label} call ${index + 1}: ${structure?.scaffold?.leftCount} left`);
    if ((structure?.scaffold?.placed ?? 0) > 0) placed.push(`${label} call ${index + 1}: ${scaffoldPlaced(call)}`);
  }
  return { passes, scaffold, placed, slowestMs };
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

/** The carried blocks the runtime's default policy admits as scaffold, as "4 dirt, 16 cobblestone": what the routes may spend. */
function admittedCarried(context: ScenarioContext): string {
  const admitted = context.bot.inventory.items().filter((item) => (DEFAULT_SCAFFOLD_BLOCKS as readonly string[]).includes(item.name));
  return admitted.map((item) => `${item.count} ${item.name}`).join(", ") || "none";
}

/** The first call after call `after` that sends cells, or -1. */
const callAfter = (inputs: readonly (PartInput | null)[], after: number): number => inputs.findIndex((part, at) => at > after && part !== null);

/** The name of the plan's stage the cut call (the one after call `after`) belongs to: what a scenario's `interruptStage` names. */
export function stageOfCutCall(plan: HousePlan, after: number): string | undefined {
  const index = callAfter(partInputs(plan, false), after);
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
 * The stages the brain's reach rule (`scaffoldNeed`) says need blocks to stand on, for a bot that stands at `walkingY` and
 * carries no block the policy admits besides the house's own: the scenario gives the bill and no dirt, and sets no
 * policy, so the runtime admits `DEFAULT_SCAFFOLD_BLOCKS`.
 */
export function flaggedStages(plan: HousePlan, walkingY: number): { stage: Stage; need: ScaffoldNeed }[] {
  const kept = plan.bill.map((entry) => entry.item);
  return plan.stages.flatMap((stage) => {
    const need = scaffoldNeed(callWorks(plan, stage, stageCells(plan, stage)), walkingY, [], DEFAULT_SCAFFOLD_BLOCKS, kept);
    return need === null ? [] : [{ stage, need }];
  });
}

/** Null when `carried` is the count the reach rule gives for the first stage it flags from `walkingY`; else what differs, so a run does not measure a count the scenario never carried. */
export function scaffoldCarriedMismatch(plan: HousePlan, walkingY: number, carriedCount: number): string | null {
  const first = flaggedStages(plan, walkingY)[0];
  if (first === undefined && carriedCount === 0) return null;
  if (first === undefined) return `scaffoldCarried is set but the reach rule flags no stage of ${plan.template.id} from y ${walkingY}: pick a template with a stage out of reach, or check the door's y in the scenario`;
  if (first.need.count === carriedCount) return null;
  return `the scenario carries ${carriedCount} scaffold dirt but the helper's count for stage ${first.stage.name} (${first.need.height} above the ground) is ${first.need.count}: set scaffoldCarried (and the scenario's dirt) to the count, if the count changed on purpose, or fix the typo`;
}

/**
 * The scaffold list the brain leaves the runtime while it builds: the kinds the default policy admits minus the bill's own
 * (`withMaterialsKept`, brain/src/gathering.ts, around `build`): a block the house needs is never laid as scaffold, so the
 * bill's last cobblestone is not spent on a route.
 */
export function scaffoldListKeepingBill(plan: HousePlan): readonly string[] {
  const billKinds = plan.bill.map((entry) => entry.item);
  return DEFAULT_SCAFFOLD_BLOCKS.filter((block) => !billKinds.includes(block));
}

/** Sets the session policy's scaffold list as `build` leaves it (`scaffoldListKeepingBill`); the failure text, or undefined when it is set. */
async function setScaffoldListKeepingBill(context: ScenarioContext, plan: HousePlan): Promise<string | undefined> {
  const status = await context.call("view_status", {});
  const revision = status.survivalPolicy?.revision;
  if (!revision) return `view_status gave no survivalPolicy revision: ${status.summary}`;
  const set = await context.call("set_survival_policy", {
    operation: "set", expected_revision: revision, changes: { navigation: { scaffold_blocks: [...scaffoldListKeepingBill(plan)] } },
    lifetime: { kind: "session" }, reason: "What I am building with is not scaffolding on the way.",
  });
  return set.result.status === "succeeded" ? undefined : `set_survival_policy read ${set.result.status}: ${set.summary}`;
}

/** What the runtime says when a route could not reach a high cell and no scaffold block is carried (`describeNoScaffold`, src/actions/build-structure/contract.ts). */
const NO_SCAFFOLD_CLAUSE = "no scaffold block carried to stand on";

/**
 * The first stage the rule flags, judged as a stage (live 2026-11-10: Bruno's roof part 5 built without scaffold and part
 * 6 failed): its calls are sent in order up to the first one that fails, which must be `[BUILD_INCOMPLETE]` with the
 * runtime's clause. Every call succeeding means the rule overflagged the stage.
 */
async function expectScaffoldStop(context: ScenarioContext, plan: HousePlan, inputs: readonly (PartInput | null)[], flagged: { stage: Stage; need: ScaffoldNeed }): Promise<string> {
  const { stage, need } = flagged;
  const built: string[] = [];
  const carriedAtStart = carried(context);
  for (let index = stage.first; index <= stage.last; index += 1) {
    const part = inputs[index];
    if (part === null || part === undefined) continue;
    const { call, highestFeetY } = await sendCall(context, part, false);
    if (call.result.status === "succeeded" && structureOf(call)?.complete === false) throw new Failed(`stage ${stage.name} call ${index + 1}/${plan.batches.length} succeeded with an incomplete audit: ${call.summary}`);
    if (call.result.status === "succeeded") { built.push(`${index + 1} (${scaffoldPlaced(call)}, feet up to y ${highestFeetY.toFixed(1)})`); continue; }
    const text = `${call.summary} ${JSON.stringify(call.result)}`;
    if (!text.includes("[BUILD_INCOMPLETE]") || !text.includes(NO_SCAFFOLD_CLAUSE)) throw new Failed(`stage ${stage.name} call ${index + 1}/${plan.batches.length} failed without the no-scaffold clause (${call.result.status}): ${call.summary}; carrying ${carried(context)}; the stop for want of scaffold is the only failure this scenario accepts: read the call's error, then the template and the door's y in the scenario`);
    return `the roof-without-scaffold stop: stage ${stage.name} (the helper's count ${need.count}, ${need.height} above the ground) built calls [${built.join(", ")}], then call ${index + 1}/${plan.batches.length} stopped: ${call.summary}`;
  }
  throw new Failed(`the reach rule flagged ${stage.name} (count ${need.count}, ${need.height} above the ground) but it built without scaffold: calls [${built.join(", ")}] all succeeded (an overflag: report it, the rule is not changed here); carried when the stage began: ${carriedAtStart}`);
}

/** Builds the stages in order, every call succeeding, up to the first flagged stage, which must stop for want of scaffold. */
async function buildUntilScaffoldStop(context: ScenarioContext, plan: HousePlan, inputs: readonly (PartInput | null)[], walkingY: number): Promise<string> {
  const flagged = flaggedStages(plan, walkingY);
  if (flagged.length === 0) throw new Failed(`expectScaffoldStop is set but the reach rule flags no stage of ${plan.template.id} from y ${walkingY}: pick a template with a stage out of reach, or check the door's y in the scenario`);
  const first = flagged[0]!;
  const unflagged = plan.stages.slice(0, plan.stages.indexOf(first.stage));
  for (const stage of unflagged) {
    const built = await sendAll(context, inputs.map((part, index) => (index >= stage.first && index <= stage.last ? part : null)), false, `stage ${stage.name}`);
    if (built.scaffold.length > 0) throw new Failed(`scaffold stands after the unflagged stage ${stage.name}: ${built.scaffold.join(", ")}`);
  }
  const stop = await expectScaffoldStop(context, plan, inputs, first);
  return `${unflagged.length} stages with no need built whole; ${stop}`;
}

/**
 * Builds one house template call by call, as `build` does (`buildParts`), then reads every cell: the support rules of
 * the engine (support.ts) against the real placement rules, which no unit test can show. With `interruptAfterBatch` a
 * call is cancelled mid-way and the whole plan is sent again, as a resumed build does. Nothing is asserted from a
 * result's wording: the cells are read back, the audit's status and its scaffold count are checked. The one wording
 * checked is the `expectScaffoldStop` run's: the runtime gives no structured field for "no scaffold block carried to
 * stand on" (`describeNoScaffold`, src/actions/build-structure/contract.ts), so that clause is read from the error text.
 */
export async function run(context: ScenarioContext): Promise<ClientCompletion> {
  const params = paramsIn(context.arena).parse(context.scenario.params);
  if (params.expectScaffoldStop && params.interruptAfterBatch !== undefined) return { status: "failed", detail: "expectScaffoldStop and interruptAfterBatch cannot be combined: the run stops at the first stage out of reach, a cut and resume would never reach it" };
  const template = templateFor(params.template);
  if (template === undefined) return { status: "failed", detail: `no template ${params.template}` };
  const plan = planTemplate(template, { door: params.door, facing: params.facing });
  if (params.scaffoldCarried !== undefined && (params.expectScaffoldStop || params.interruptAfterBatch !== undefined)) return { status: "failed", detail: "scaffoldCarried builds the whole template in one pass: it cannot be combined with expectScaffoldStop or interruptAfterBatch" };
  const mismatch = params.scaffoldCarried === undefined ? null : scaffoldCarriedMismatch(plan, params.door.y, params.scaffoldCarried);
  if (mismatch !== null) return { status: "failed", detail: mismatch };
  // Both runs leave the policy's scaffold list as `build` does: without it the runtime would lay the bill's own spare block (a cobblestone) as scaffold and the stop would never come.
  if (params.scaffoldCarried !== undefined || params.expectScaffoldStop) {
    const refused = await setScaffoldListKeepingBill(context, plan);
    if (refused !== undefined) return { status: "failed", detail: refused };
  }
  const inputs = partInputs(plan, params.scaffoldCarried !== undefined);
  const started = performance.now();
  const notes: string[] = [];
  try {
    if (params.expectScaffoldStop) {
      const detail = await buildUntilScaffoldStop(context, plan, inputs, params.door.y);
      return { status: "succeeded", detail: `${template.id} (${params.facing}): ${detail} in ${seconds(started)} s` };
    }
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
    const placed = first.placed.join(", ");
    if (placed !== "") notes.push(`routes' scaffold (taken down again): ${placed}`);
    return { status: "succeeded", detail: `${template.id} (${params.facing}): ${notes.join("; ")} in ${seconds(started)} s (${first.passes} passes, final check ${final.passes}; slowest call ${Math.max(first.slowestMs, final.slowestMs)} ms)` };
  } catch (error) {
    if (!(error instanceof Failed)) throw error;
    return { status: "failed", detail: `${template.id} after ${seconds(started)} s: ${[...notes, error.message].join("; ")}` };
  }
}
