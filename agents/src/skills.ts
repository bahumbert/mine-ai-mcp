import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { describeStep, type Step } from "./actions.ts";
import { describeMaterials, shortfall } from "./building/blueprint.ts";
import { chooseSite, planHouse, styleOrDefault } from "./building/plan.ts";
import type { Body } from "./body.ts";
import { gatherMaterials } from "./gathering.ts";
import type { BotRuntime, BotSnapshot, ForegroundTool, NearbyPlayer, Position } from "./runtime-client.ts";

/** Pause between follow checks while already close enough. */
const FOLLOW_POLL_MS = 750;
/** Extra blocks tolerated beyond the follow distance before moving, so the bot does not twitch at every step. */
const FOLLOW_SLACK = 1.5;
/** A followed player this far from the current navigation target triggers a re-plan. */
const REPLAN_DISTANCE = 4;
/** Consecutive checks without seeing the followed player before giving up (~ FOLLOW_LOST_CHECKS * poll). */
const FOLLOW_LOST_CHECKS = 8;
/** Consecutive failed navigation legs before following gives up (unreachable player). */
const FOLLOW_MAX_FAILURES = 3;
/** Stop this close to a player we walk up to. */
const COME_RANGE = 2;
/** Arrival tolerance for `go_to` coordinates. */
const GO_TO_RANGE = 1;

export interface SkillContext {
  readonly runtime: BotRuntime;
  readonly body: Body;
  readonly signal: AbortSignal;
  /** Who asked: a house faces them. */
  readonly requester?: string;
  /** The persona's building style, used when a build step names none. */
  readonly style?: string;
}

export type SkillResult =
  | { readonly status: "done"; readonly detail: string }
  | { readonly status: "failed"; readonly detail: string }
  /** Aborted by the agent (a new order or "stop"); nothing to report. */
  | { readonly status: "stopped" };

/**
 * Runs the steps in order and stops at the first one that does not finish. "stop" is not a skill; the agent aborts
 * the running plan.
 */
export async function runPlan(steps: readonly Step[], context: SkillContext): Promise<SkillResult> {
  const done: string[] = [];
  for (const [index, step] of steps.entries()) {
    const result = await runStep(step, context);
    if (result.status === "stopped") return result;
    if (result.status === "failed") {
      if (steps.length === 1) return result;
      const before = done.length === 0 ? "" : `; already did: ${done.join(", ")}`;
      return { status: "failed", detail: `step ${index + 1}/${steps.length} (${describeStep(step)}) failed: ${result.detail}${before}` };
    }
    done.push(result.detail);
  }
  return { status: "done", detail: done.join("; ") };
}

/**
 * Brain-level skills: short programs over atomic actions. Following is done here with repeated `navigate` rather
 * than a new runtime action; if that proves too jerky it becomes a `follow_entity` action (backlog).
 */
export async function runStep(step: Step, context: SkillContext): Promise<SkillResult> {
  const why = `A player asked me to ${describeStep(step)}.`;
  try {
    switch (step.skill) {
      case "follow_player": return await follow(context, step.player, step.distance);
      case "go_to_player": return await come(context, step.player);
      case "go_to":
        return await once(context, "navigate", { x: step.x, y: step.y, z: step.z, range: GO_TO_RANGE }, why, `reached ${step.x} ${step.y} ${step.z}`);
      case "collect_block":
        return await once(context, "collect_block", { block_name: step.block, count: step.count }, why, `collected ${step.count} ${step.block}`);
      case "give_item": return await give(context, step.player, step.item, step.count);
      case "craft_item":
        return await once(context, "craft_item", { items: [{ item_name: step.item, count: step.count }] }, why, `crafted ${step.count} ${step.item}`);
      case "eat": return await once(context, "eat_food", { food_name: step.food }, why, `ate ${step.food}`);
      case "equip": return await once(context, "equip", { items: [{ item_name: step.item }] }, why, `equipped ${step.item}`);
      case "sleep": return await once(context, "sleep", {}, why, "slept");
      case "hunt":
        return await once(context, "collect_mob_drop", { mob_name: step.mob, drop_name: step.drop, count: step.count }, why, `got ${step.count} ${step.drop} from ${step.mob}`);
      case "build": return await build(context, step);
    }
  } catch (error) {
    if (context.signal.aborted) return { status: "stopped" };
    throw error;
  }
}

export type FollowStep =
  | { readonly kind: "lost" }
  | { readonly kind: "hold" }
  | { readonly kind: "move"; readonly target: Position };

/** Pure follow decision for one tick. */
export function planFollowStep(snapshot: BotSnapshot, player: string, distance: number): FollowStep {
  const target = findPlayer(snapshot, player)?.position ?? null;
  if (target === null) return { kind: "lost" };
  if (distanceBetween(snapshot.position, target) <= distance + FOLLOW_SLACK) return { kind: "hold" };
  return { kind: "move", target };
}

async function follow(context: SkillContext, player: string, distance: number): Promise<SkillResult> {
  const { runtime, body, signal } = context;
  let unseen = 0;
  let failures = 0;
  while (!signal.aborted) {
    const step = planFollowStep(await runtime.status(), player, distance);
    if (step.kind === "lost") {
      unseen += 1;
      if (unseen >= FOLLOW_LOST_CHECKS) return { status: "failed", detail: `lost sight of ${player}` };
      await sleep(FOLLOW_POLL_MS, undefined, { signal });
      continue;
    }
    unseen = 0;
    if (step.kind === "hold") {
      await sleep(FOLLOW_POLL_MS, undefined, { signal });
      continue;
    }
    const target = step.target;
    const outcome = await body.act("navigate", navigateInput(target, distance), `Follow ${player}.`, {
      signal,
      interruptible: true,
      interruptWhen: async () => {
        const now = findPlayer(await runtime.status(), player)?.position ?? null;
        return now !== null && distanceBetween(now, target) > REPLAN_DISTANCE;
      },
    });
    // Pre-empted legs and partial arrivals are normal while following: the next tick re-plans from where we are.
    if (outcome.status === "refused") return { status: "failed", detail: outcome.error ?? "navigation refused" };
    if (outcome.status === "failed" && !outcome.preempted) {
      failures += 1;
      if (failures >= FOLLOW_MAX_FAILURES) return { status: "failed", detail: outcome.error ?? `cannot reach ${player}` };
      await sleep(FOLLOW_POLL_MS, undefined, { signal });
    } else {
      failures = 0;
    }
  }
  return { status: "stopped" };
}

async function come(context: SkillContext, player: string): Promise<SkillResult> {
  const target = findPlayer(await context.runtime.status(), player)?.position ?? null;
  if (target === null) return { status: "failed", detail: `cannot see ${player}` };
  const outcome = await context.body.act("navigate", navigateInput(target, COME_RANGE), `Go to ${player} who called me.`, { signal: context.signal });
  if (context.signal.aborted) return { status: "stopped" };
  if (outcome.status === "succeeded") return { status: "done", detail: `reached ${player}` };
  return { status: "failed", detail: outcome.error ?? `navigation ${outcome.status}` };
}

async function once(context: SkillContext, tool: ForegroundTool, input: Record<string, unknown>, rationale: string, doneDetail: string): Promise<SkillResult> {
  const outcome = await context.body.act(tool, input, rationale, { signal: context.signal });
  if (context.signal.aborted) return { status: "stopped" };
  if (outcome.status === "succeeded") return { status: "done", detail: doneDetail };
  return { status: "failed", detail: outcome.error ?? `${tool} ${outcome.status}` };
}

async function give(context: SkillContext, player: string, item: string, count: number): Promise<SkillResult> {
  const approach = await come(context, player);
  if (approach.status !== "done") return approach;
  return once(context, "drop_item", { items: [{ item_name: item, count }], to_player: player }, `${player} asked me for ${item}.`, `gave ${count} ${item} to ${player}`);
}

/**
 * Builds a house from a style's blueprint where the bot stood when asked, facing the requester. Missing materials are
 * gathered and crafted first (`gathering.ts`), then the bot walks back to that spot and sends one `build_structure`
 * call per batch.
 */
async function build(context: SkillContext, step: Extract<Step, { skill: "build" }>): Promise<SkillResult> {
  const snapshot = await context.runtime.status();
  const toward = context.requester === undefined ? null : findPlayer(snapshot, context.requester)?.position ?? null;
  const plan = planHouse(styleOrDefault(step.style ?? context.style), step.size, chooseSite(snapshot.position, toward));
  const what = `a ${step.size} ${plan.style.id} house`;
  if (shortfall(plan.bill, snapshot.inventory).length > 0) {
    const gathered = await gatherMaterials(context, plan.bill, what, snapshot.position);
    if (gathered.status === "stopped") return gathered;
    if (gathered.status === "failed") return { status: "failed", detail: `could not get the materials for ${what} (it needs ${describeMaterials(plan.bill)}): ${gathered.detail}` };
    const back = await once(context, "navigate", navigateInput(snapshot.position, GO_TO_RANGE), `Go back to where I was asked to build ${what}.`, "back at the site");
    if (back.status !== "done") return back.status === "stopped" ? back : { status: "failed", detail: `gathered the materials but could not get back to the site: ${back.detail}` };
  }
  for (const [index, batch] of plan.batches.entries()) {
    const blocks = batch.map(({ x, y, z, block }) => ({ x, y, z, block_name: block }));
    const part = `part ${index + 1}/${plan.batches.length}`;
    const outcome = await context.body.act("build_structure", { blocks, remove_wrong_blocks: true }, `Build ${what}, ${part}.`, { signal: context.signal });
    if (context.signal.aborted) return { status: "stopped" };
    if (outcome.status !== "succeeded") return { status: "failed", detail: `${what} stopped at ${part}: ${outcome.error ?? outcome.status}${auditSuffix(outcome.error, outcome.result)}` };
  }
  const { door, facing } = plan.site;
  return { status: "done", detail: `built ${what}, door at ${door.x} ${door.y} ${door.z} facing ${facing}` };
}

/** The part of `build_structure`'s audit the skill reports (src/actions/build-structure/contract.ts). */
const structureAuditSchema = z.object({
  structure: z.object({
    placed: z.number(),
    dug: z.number(),
    left: z.array(z.object({ reason: z.string(), count: z.number() })),
    missing: z.array(z.object({ block: z.string(), count: z.number() })),
  }),
});

/**
 * Why cells were left, for the planner: `[BUILD_INCOMPLETE]` errors already list it, but `[BUILD_STOPPED]` and
 * tool-loss errors do not.
 */
function auditSuffix(error: string | null, result: Readonly<Record<string, unknown>> | undefined): string {
  if (error?.startsWith("[BUILD_INCOMPLETE]") === true) return "";
  const parsed = structureAuditSchema.safeParse(result);
  if (!parsed.success) return "";
  const { placed, dug, left, missing } = parsed.data.structure;
  const parts = [`placed ${placed}, dug ${dug}`];
  if (left.length > 0) parts.push(`left ${left.map((group) => `${group.count} ${group.reason}`).join(", ")}`);
  if (missing.length > 0) parts.push(`short of ${missing.map((entry) => `${entry.count} ${entry.block}`).join(", ")}`);
  return ` (${parts.join("; ")})`;
}

function findPlayer(snapshot: BotSnapshot, username: string): NearbyPlayer | undefined {
  const wanted = username.toLowerCase();
  return snapshot.players.find((entry) => entry.username.toLowerCase() === wanted);
}

function navigateInput(target: Position, range: number): Record<string, unknown> {
  return { x: Math.floor(target.x), y: Math.floor(target.y), z: Math.floor(target.z), range };
}

function distanceBetween(a: Position, b: Position): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
