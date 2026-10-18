import { z } from "zod";
import type { ClientCompletion } from "mine-labs/client";
import type { ScenarioContext } from "../scenario.ts";

const requestSchema = z.strictObject({
  actions: z.array(z.strictObject({
    action: z.string().trim().min(1),
    input: z.record(z.string(), z.unknown()),
    /** The status the step must end with; a step that is meant to fail says so and the sequence goes on. */
    /** Ticks to let the world run before this step, e.g. for the server to report a changing air supply. */
    waitTicks: z.number().int().nonnegative().default(0),
    expect: z.enum(["succeeded", "failed"]).default("succeeded"),
  })).min(1),
});

/** YAML owns the steps; stop at the first failure. Mine Labs checks the final world. */
export async function run(context: ScenarioContext): Promise<ClientCompletion> {
  const { actions } = requestSchema.parse(context.scenario.params);
  const summaries: string[] = [];
  for (const [index, { action, input, expect, waitTicks }] of actions.entries()) {
    if (waitTicks > 0) await context.waitForTicks(waitTicks);
    const output = await context.call(action, input);
    summaries.push(`${index + 1}. ${output.summary}`);
    if (output.result.status !== expect) {
      return { status: "failed", detail: summaries.join("; ") };
    }
  }
  return { status: "succeeded", detail: summaries.join("; ") };
}
