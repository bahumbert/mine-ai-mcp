import { z } from "zod";
import type { ClientCompletion } from "mine-labs/client";
import type { ScenarioContext } from "../scenario.ts";

const requestSchema = z.strictObject({
  /** The style override the persona carries: routes may not dig straight down. */
  noDigStraightDown: z.boolean(),
  target: z.tuple([z.number(), z.number(), z.number()]),
  range: z.number().nonnegative(),
});

/** Set the bot's style override as run 15's personas had it, then navigate; Mine Labs checks the final world. */
export async function run(context: ScenarioContext): Promise<ClientCompletion> {
  const { noDigStraightDown, target: [x, y, z], range } = requestSchema.parse(context.scenario.params);
  if (noDigStraightDown) {
    const status = await context.call("view_status", {});
    const revision = (status.result as { survivalPolicy?: { revision?: string } }).survivalPolicy?.revision;
    if (!revision) return { status: "failed", detail: `view_status gave no survivalPolicy revision: ${status.summary}` };
    const set = await context.call("set_survival_policy", {
      operation: "set", expected_revision: revision, changes: { navigation: { dig_straight_down: false } },
      lifetime: { kind: "session" }, reason: "I never dig straight down: I go down by staircase",
    });
    if (set.result.status !== "succeeded") return { status: "failed", detail: set.summary };
  }
  const output = await context.call("navigate", { x, y, z, range });
  return output.result.status === "succeeded"
    ? { status: "succeeded", detail: output.summary }
    : { status: "failed", detail: output.summary };
}
