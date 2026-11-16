import { z } from "zod";
import type { ClientCompletion } from "mine-labs/client";
import { arenaActionInput } from "../arena/frame.ts";
import type { ScenarioContext } from "../scenario.ts";
import { waitServerTicks } from "./server-ticks.ts";

const requestSchema = z.strictObject({
  actions: z.array(z.strictObject({
    action: z.string().trim().min(1),
    input: z.record(z.string(), z.unknown()),
    /** Ticks to let the world run before this step, e.g. for the server to report a changing air supply. */
    waitTicks: z.number().int().nonnegative().default(0),
    /** Server ticks, including a packet of margin before the next step reads the server's state. */
    waitServerTicks: z.number().int().nonnegative().default(0),
    /** The status the step must end with; a step that is meant to fail says so and the sequence goes on. */
    expect: z.enum(["succeeded", "failed"]).default("succeeded"),
  })).min(1),
});

/** YAML owns the steps; stop at the first failure. Mine Labs checks the final world. */
export async function run(context: ScenarioContext): Promise<ClientCompletion> {
  const { actions } = requestSchema.parse(context.scenario.params);
  const summaries: string[] = [];
  for (const [index, { action, input, expect, waitTicks, waitServerTicks: serverTicks }] of actions.entries()) {
    if (waitTicks > 0) await context.waitForTicks(waitTicks);
    if (serverTicks > 0 && await waitServerTicks(context.bot, serverTicks) === "stalled") {
      return { status: "failed", detail: `${index + 1}. the server's clock stood still` };
    }
    const output = await context.call(action, arenaActionInput(input, context.arena));
    summaries.push(`${index + 1}. ${output.summary}`);
    if (output.result.status !== expect) {
      return { status: "failed", detail: summaries.join("; ") };
    }
  }
  return { status: "succeeded", detail: summaries.join("; ") };
}
