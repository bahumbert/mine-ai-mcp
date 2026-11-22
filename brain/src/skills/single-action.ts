// The skills that are one body action: go_to, collect_block, eat, equip, sleep, hunt, and `once`, which runs them.
import type { Step } from "../actions.ts";
import { FETCH_RANGE, notNear } from "../gathering/fetch-farther.ts";
import { noSpareFact } from "../relations/items.ts";
import type { ForegroundTool } from "../runtime-client.ts";
import type { SkillContext, SkillResult } from "../skills.ts";
import { houseReserve, walkKeeping } from "../walks.ts";
import { GO_TO_RANGE } from "./positions.ts";

export async function once(context: SkillContext, tool: ForegroundTool, input: Record<string, unknown>, rationale: string, doneDetail: string): Promise<SkillResult> {
  const outcome = await context.body.act(tool, input, rationale, { signal: context.signal });
  if (context.signal.aborted) return { status: "stopped" };
  if (outcome.status === "succeeded") return { status: "done", detail: doneDetail };
  return { status: "failed", detail: outcome.error ?? `${tool} ${outcome.status}` };
}

/** The model's own walk: it keeps an unfinished house's blocks (`houseReserve`), and on no path is walked once more by the one retry rule (plan 2026-11-14 Task 7b, spec open choice 4). */
export async function goTo(context: SkillContext, step: Extract<Step, { skill: "go_to" }>, why: string): Promise<SkillResult> {
  const outcome = await walkKeeping(context, { x: step.x, y: step.y, z: step.z }, why, (await houseReserve(context)).keep, [], GO_TO_RANGE);
  if (context.signal.aborted) return { status: "stopped" };
  return outcome.status === "succeeded" ? { status: "done", detail: `reached ${step.x} ${step.y} ${step.z}` } : { status: "failed", detail: outcome.error ?? `navigate ${outcome.status}` };
}

export async function collectBlock(context: SkillContext, step: Extract<Step, { skill: "collect_block" }>, why: string): Promise<SkillResult> {
  // Within the fetch range, like get_items: a trip is a go_to of its own (spec 2026-10-03 fetch-range).
  const collected = await once(context, "collect_block", { block_name: step.block, count: step.count, max_distance: FETCH_RANGE }, why, `collected ${step.count} ${step.block}`);
  return collected.status === "failed" ? { status: "failed", detail: await notNear(context, step.block, collected.detail) } : collected;
}

/** Eats the named food, unless an agreed trade owes, or a trade that ended holds, all of what is carried of it. */
export async function eat(context: SkillContext, step: Extract<Step, { skill: "eat" }>, why: string): Promise<SkillResult> {
  const owed = context.owed?.() ?? [];
  const fact = owed.length === 0 ? null : noSpareFact(owed, (await context.runtime.status()).inventory, step.food);
  // No refusal from the bar here: golden apples and chorus fruit are edible when it is full, so the game answers.
  return fact === null ? await once(context, "eat_food", { food_name: step.food }, why, `ate ${step.food}`) : { status: "failed", detail: fact };
}

export async function equip(context: SkillContext, step: Extract<Step, { skill: "equip" }>, why: string): Promise<SkillResult> {
  return await once(context, "equip", { items: [{ item_name: step.item }] }, why, `equipped ${step.item}`);
}

export async function sleep(context: SkillContext, _step: Extract<Step, { skill: "sleep" }>, why: string): Promise<SkillResult> {
  return await once(context, "sleep", {}, why, "slept");
}

export async function hunt(context: SkillContext, step: Extract<Step, { skill: "hunt" }>, why: string): Promise<SkillResult> {
  return await once(context, "collect_mob_drop", { mob_name: step.mob, drop_name: step.drop, count: step.count }, why, `got ${step.count} ${step.drop} from ${step.mob}`);
}
