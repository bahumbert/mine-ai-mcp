import { z } from "zod";
import { smeltItemResultSchema } from "@aibengineering/mine-ai-mcp";
import type { ClientCompletion } from "mine-labs/client";
import type { ScenarioContext } from "../scenario.ts";

const requestSchema = z.strictObject({
  smelt: z.record(z.string(), z.unknown()),
  /** The smelt must produce this many, with nothing interrupting it. */
  produced: z.number().int().positive(),
  /** The route that starts from wherever the smelt left the body. */
  navigate: z.record(z.string(), z.unknown()),
});

/** One workstation action that is not to be interrupted, then a route from where it left the bot. */
export async function run(context: ScenarioContext): Promise<ClientCompletion> {
  const { smelt, produced, navigate } = requestSchema.parse(context.scenario.params);
  const smelted = await context.call("smelt_item", smelt);
  if (smelted.result.status !== "succeeded") return { status: "failed", detail: `smelt: ${smelted.summary}` };
  if (smelted.interruptions?.length) return { status: "failed", detail: `smelt interrupted: ${smelted.interruptions.join(" | ")}` };
  const receipt = smeltItemResultSchema.parse(smelted.result);
  if (receipt.smelt.produced !== produced) {
    return { status: "failed", detail: `smelt produced ${receipt.smelt.produced}, wanted ${produced}: ${smelted.summary}` };
  }
  const routed = await context.call("navigate", navigate);
  if (routed.result.status !== "succeeded") return { status: "failed", detail: `navigate after the smelt: ${routed.summary}` };
  return { status: "succeeded", detail: `${smelted.summary}; ${routed.summary}` };
}
