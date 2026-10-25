import { z } from "zod";
import type { ClientCompletion } from "mine-labs/client";
import type { ArenaFrame } from "../arena/frame.ts";
import { arenaPoint } from "../arena/params.ts";
import type { ScenarioContext } from "../scenario.ts";

const requestSchemaIn = (arena: ArenaFrame) => z.strictObject({
  /** The style override the persona carries: routes may not dig straight down. */
  noDigStraightDown: z.boolean(),
  target: arenaPoint(arena),
  range: z.number().nonnegative(),
});

/** Set the style override run 15's personas carried (`navigation.dig_straight_down` false); the failure is a driver detail. */
export async function forbidDigStraightDown(context: ScenarioContext): Promise<ClientCompletion | undefined> {
  const status = await context.call("view_status", {});
  const revision = status.survivalPolicy?.revision;
  if (!revision) return { status: "failed", detail: `view_status gave no survivalPolicy revision: ${status.summary}` };
  const set = await context.call("set_survival_policy", {
    operation: "set", expected_revision: revision, changes: { navigation: { dig_straight_down: false } },
    lifetime: { kind: "session" }, reason: "I never dig straight down: I go down by staircase",
  });
  return set.result.status === "succeeded" ? undefined : { status: "failed", detail: set.summary };
}

/** Set the bot's style override as run 15's personas had it, then navigate; Mine Labs checks the final world. */
export async function run(context: ScenarioContext): Promise<ClientCompletion> {
  const { noDigStraightDown, target: [x, y, z], range } = requestSchemaIn(context.arena).parse(context.scenario.params);
  if (noDigStraightDown) {
    const refused = await forbidDigStraightDown(context);
    if (refused) return refused;
  }
  const output = await context.call("navigate", { x, y, z, range });
  return output.result.status === "succeeded"
    ? { status: "succeeded", detail: output.summary }
    : { status: "failed", detail: output.summary };
}
