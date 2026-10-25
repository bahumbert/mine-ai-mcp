import { z } from "zod";
import { viewStatusResultSchema } from "@aibengineering/mine-ai-mcp";
import { arenaActionInput } from "../arena/frame.ts";
import type { ScenarioRun } from "../scenario.ts";

const paramsSchema = z.strictObject({
  actions: z.array(z.strictObject({
    action: z.string().trim().min(1),
    input: z.record(z.string(), z.unknown()),
    /** A step meant to fail says so and the sequence goes on. */
    expect: z.enum(["succeeded", "failed"]).default("succeeded"),
    /** For a step meant to fail: the text its error must hold, so a refusal before any route is not mistaken for the failure under test. */
    error_contains: z.string().min(1).optional(),
  })).min(1),
  /** After the last step, the most of each item the bot may carry: the buried stacks must not be back in the inventory. */
  carried_at_most: z.record(z.string(), z.number().int().nonnegative()),
});

/** Run the steps, then read the inventory: Mine Labs goals can say "carries at least", never "carries at most". */
export const run: ScenarioRun = async (context) => {
  const { actions, carried_at_most } = paramsSchema.parse(context.scenario.params);
  const summaries: string[] = [];
  for (const [index, { action, input, expect, error_contains }] of actions.entries()) {
    const output = await context.call(action, arenaActionInput(input, context.arena));
    summaries.push(`${index + 1}. ${output.summary}`);
    const error = "error" in output.result ? String(output.result.error) : "";
    if (output.result.status !== expect || (error_contains !== undefined && !error.includes(error_contains))) {
      return { status: "failed", detail: summaries.join("; ") };
    }
  }
  const status = viewStatusResultSchema.parse((await context.call("view_status", {})).result);
  if (status.status !== "succeeded") return { status: "failed", detail: `view_status failed; ${summaries.join("; ")}` };
  const carried = (name: string) => status.situation.inventory.stacks.filter((stack) => stack.name === name).reduce((sum, stack) => sum + stack.count, 0);
  const over = Object.entries(carried_at_most).filter(([name, most]) => carried(name) > most);
  const counts = Object.keys(carried_at_most).map((name) => `${name} ${carried(name)}`).join(", ");
  if (over.length > 0) return { status: "failed", detail: `Carries more than the buried stacks allow (${counts}); ${summaries.join("; ")}` };
  return { status: "succeeded", detail: `Carrying ${counts}; ${summaries.join("; ")}` };
};
