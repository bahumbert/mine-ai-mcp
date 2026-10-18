import { z } from "zod";
import type { ClientCompletion } from "mine-labs/client";
import type { ScenarioContext } from "../scenario.ts";

const requestSchema = z.strictObject({
  /** The runtime's pinned window, shortened from ten minutes: the host reads it. */
  pinnedWindowMs: z.number().int().positive(),
  target: z.tuple([z.number(), z.number(), z.number()]),
  /** Ticks to stand in the box once the failures are in, a little longer than the window. */
  waitTicks: z.number().int().positive(),
});

/** A bot shut in a box: three navigates fail, the window passes, the escape fails too, then movement is refused at once. */
export async function run(context: ScenarioContext): Promise<ClientCompletion> {
  const { target: [x, y, z], waitTicks } = requestSchema.parse(context.scenario.params);
  const walk = () => context.call("navigate", { x, y, z, range: 1, dig: false });
  for (let attempt = 1; attempt <= 3; attempt++) {
    const failed = await walk();
    if (failed.result.status !== "failed") return { status: "failed", detail: `attempt ${attempt} should fail in the box: ${failed.summary}` };
  }
  await context.waitForTicks(waitTicks);
  const escape = await walk();
  if (escape.result.status !== "failed") return { status: "failed", detail: `the escape cannot leave a sealed box: ${escape.summary}` };
  const refused = await walk();
  const error = "error" in refused.result ? refused.result.error : "";
  if (!error.startsWith("[PINNED]")) return { status: "failed", detail: `expected [PINNED] at once: ${refused.summary}` };
  return refused.durationMs < 1_000
    ? { status: "succeeded", detail: refused.summary }
    : { status: "failed", detail: `[PINNED] took ${refused.durationMs} ms: ${refused.summary}` };
}
