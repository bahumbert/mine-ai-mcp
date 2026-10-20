import { z } from "zod";
import type { ClientCompletion } from "mine-labs/client";
import type { ScenarioContext } from "../scenario.ts";

const cellSchema = z.tuple([z.number(), z.number(), z.number()]);
const requestSchema = z.strictObject({
  /** Client ticks the stance must read airborne at the same height before the navigate, or the setup did not reproduce ghost air. */
  holdTicks: z.number().int().positive(),
  /** Each case: the navigate target after the cell under the bot (its client copy becomes air; the server keeps its block). */
  cases: z.array(z.strictObject({ target: cellSchema })).min(1),
  /** The chest under the first case must stay shut: the resend must not use an item or open a container. */
  openedWindowsAllowed: z.number().int().nonnegative(),
});

/** The client's copy of the cell under the bot is air, the server's is solid: the bot hangs, then a navigate must free it. */
export async function run(context: ScenarioContext): Promise<ClientCompletion> {
  const { holdTicks, cases, openedWindowsAllowed } = requestSchema.parse(context.scenario.params);
  const details: string[] = [];
  for (const [index, { target }] of cases.entries()) {
    const start = context.client.body();
    const startY = start.y;
    await context.client.setCell([Math.floor(start.x), Math.floor(start.y - 0.5), Math.floor(start.z)], 0);
    let airborneTicks = 0;
    for (let tick = 0; tick < holdTicks; tick += 1) {
      await context.waitForTicks(1);
      if (!context.client.body().onGround) airborneTicks += 1;
    }
    const held = context.client.body();
    if (airborneTicks < holdTicks / 2 || Math.abs(held.y - startY) >= 0.3)
      return { status: "failed", detail: `case ${index}: the setup did not hold the bot in the air (airborne ${airborneTicks} of ${holdTicks} ticks, y ${held.y.toFixed(2)} from ${startY.toFixed(2)})` };
    const [x, y, z] = target;
    const walked = await context.call("navigate", { x, y, z, range: 1, dig: false });
    if (walked.result.status !== "succeeded") return { status: "failed", detail: `case ${index}: the navigate from the held stance read ${walked.result.status}: ${walked.summary}` };
    details.push(`case ${index}: held ${airborneTicks}/${holdTicks} ticks, then ${walked.summary}`);
  }
  const opened = context.client.windowsOpened();
  if (opened > openedWindowsAllowed) return { status: "failed", detail: `the resend opened ${opened} container window(s); ${details.join("; ")}` };
  return { status: "succeeded", detail: details.join("; ") };
}
