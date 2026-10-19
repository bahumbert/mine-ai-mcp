import { z } from "zod";
import type { ClientCompletion } from "mine-labs/client";
import type { ScenarioContext } from "../scenario.ts";
import { forbidDigStraightDown } from "./styled-navigate.ts";

const requestSchema = z.strictObject({
  /** The runtime's pinned window, shortened from ten minutes: the host reads it. */
  pinnedWindowMs: z.number().int().positive(),
  target: z.tuple([z.number(), z.number(), z.number()]),
  /** Ticks to stand in the corridor once the failures are in, a little longer than the window. */
  waitTicks: z.number().int().positive(),
});

/**
 * A bot with the style override "never dig straight down" fails three navigates to a cave under its corridor, stays past the
 * (here shortened) pinned window, and its next navigate runs as an escape: the escape sets the override aside for the whole
 * route and digs down.
 */
export async function run(context: ScenarioContext): Promise<ClientCompletion> {
  const { target: [x, y, z], waitTicks } = requestSchema.parse(context.scenario.params);
  const refused = await forbidDigStraightDown(context);
  if (refused) return refused;
  const walk = () => context.call("navigate", { x, y, z, range: 0 });
  for (let attempt = 1; attempt <= 3; attempt++) {
    const failed = await walk();
    if (failed.result.status !== "failed") return { status: "failed", detail: `attempt ${attempt} should fail in the corridor: ${failed.summary}` };
  }
  await context.waitForTicks(waitTicks);
  const escape = await walk();
  return escape.result.status === "succeeded"
    ? { status: "succeeded", detail: escape.summary }
    : { status: "failed", detail: `the escape did not dig out: ${escape.summary}` };
}
