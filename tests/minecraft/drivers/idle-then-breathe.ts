import { z } from "zod";
import { viewStatusResultSchema } from "@aibengineering/mine-ai-mcp";
import type { ClientCompletion } from "mine-labs/client";
import type { ScenarioContext } from "../scenario.ts";

const requestSchema = z.strictObject({
  /** How long the body idles with no action, long enough for the air to run to the reflex's threshold and beyond. */
  idleSeconds: z.number().positive(),
  /** The air the bot must have again at the end. */
  minimumAirTicks: z.number().int(),
});

/** No action runs: only the breath reflex can save a bot left under water; then check it breathes. */
export async function run(context: ScenarioContext): Promise<ClientCompletion> {
  const { idleSeconds, minimumAirTicks } = requestSchema.parse(context.scenario.params);
  await context.waitForTicks(Math.round(idleSeconds * 20));
  const status = viewStatusResultSchema.parse((await context.call("view_status", {})).result);
  if (status.status !== "succeeded") return { status: "failed", detail: "view_status failed" };
  const air = status.situation.vitals.airSupplyTicks;
  const detail = `air ${air} at ${JSON.stringify(status.situation.position)}, health ${status.situation.vitals.health}`;
  return { status: air !== null && air >= minimumAirTicks ? "succeeded" : "failed", detail };
}
