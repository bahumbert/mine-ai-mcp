import { z } from "zod";
import type { ClientCompletion } from "mine-labs/client";
import { arenaActionInput } from "../arena/frame.ts";
import type { ScenarioContext } from "../scenario.ts";
import { waitServerTicks } from "./server-ticks.ts";

const requestSchema = z.strictObject({
  debugExecuteJavaScript: z.boolean().optional(),
  actions: z.array(z.strictObject({
    action: z.string().trim().min(1),
    input: z.record(z.string(), z.unknown()),
    /** Server ticks, including a packet of margin before the next step reads the server's state. */
    waitServerTicks: z.number().int().nonnegative().default(0),
    /** The status the step must end with; a step that is meant to fail says so and the sequence goes on. */
    expect: z.enum(["succeeded", "failed"]).default("succeeded"),
    errorContains: z.array(z.string()).optional(),
    errorAbsent: z.array(z.string()).optional(),
    awaitChat: z.string().optional(),
  })).min(1),
});

/** Describe a failed step's first unmet error expectation. */
function errorMismatch(error: string, contains?: string[], absent?: string[]): string | undefined {
  return contains?.find((text) => !error.includes(text)) ?? absent?.find((text) => error.includes(text));
}

/** YAML owns the steps; stop at the first failure. Mine Labs checks the final world. */
export async function run(context: ScenarioContext): Promise<ClientCompletion> {
  const { actions } = requestSchema.parse(context.scenario.params);
  const summaries: string[] = [];
  for (const [index, { action, input, expect, waitServerTicks: serverTicks, errorContains, errorAbsent, awaitChat }] of actions.entries()) {
    let witnessed = false;
    const onMessage = (message: string) => { if (message.includes(awaitChat ?? "")) witnessed = true; };
    if (serverTicks > 0 && await waitServerTicks(context.bot, serverTicks) === "stalled") {
      return { status: "failed", detail: `${index + 1}. the server's clock stood still` };
    }
    if (awaitChat !== undefined) context.bot.on("messagestr", onMessage);
    try {
      const output = await context.call(action, arenaActionInput(input, context.arena));
      summaries.push(`${index + 1}. ${output.summary}`);
      if (output.result.status !== expect) {
        return { status: "failed", detail: summaries.join("; ") };
      }
      if (awaitChat !== undefined && !witnessed) {
        return { status: "failed", detail: `${summaries.join("; ")}; ${index + 1}. missing chat ${JSON.stringify(awaitChat)}` };
      }
      const error = output.result.status === "failed" ? output.result.error : undefined;
      const mismatch = error === undefined ? undefined : errorMismatch(error, errorContains, errorAbsent);
      if (mismatch !== undefined) {
        return { status: "failed", detail: `${index + 1}. error text ${JSON.stringify(mismatch)}; error ${JSON.stringify(error)}` };
      }
    } finally {
      if (awaitChat !== undefined) context.bot.off("messagestr", onMessage);
    }
  }
  return { status: "succeeded", detail: summaries.join("; ") };
}
