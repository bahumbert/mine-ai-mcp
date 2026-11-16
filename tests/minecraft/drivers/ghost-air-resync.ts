import { z } from "zod";
import type { ClientCompletion } from "mine-labs/client";
import type { ArenaFrame } from "../arena/frame.ts";
import { arenaPoint } from "../arena/params.ts";
import type { ScenarioContext } from "../scenario.ts";
import { waitServerTicks } from "./server-ticks.ts";

const requestSchemaIn = (arena: ArenaFrame) => z.strictObject({
  /** Server ticks to hold the stance, sampled on client ticks, before the navigate. */
  holdTicks: z.number().int().positive(),
  /** Each case: the navigate target after the cell under the bot (its client copy becomes air; the server keeps its block). */
  cases: z.array(z.strictObject({ target: arenaPoint(arena) })).min(1),
  /** The chest under the first case must stay shut: the resend must not use an item or open a container. */
  openedWindowsAllowed: z.number().int().nonnegative(),
});

/** Sample every client tick while the server hold, including its stale-packet margin, passes. */
async function sampleHeldBody(context: ScenarioContext, holdTicks: number) {
  let samples = 0;
  let airborne = 0;
  const waited = await waitServerTicks(context.bot, holdTicks, {
    // Physics samples, rather than the helper's polling interval, determine the airborne fraction (T10, 2026-11-15).
    sleep: async () => {
      await context.bot.waitForTicks(1);
      samples += 1;
      if (!context.client.body().onGround) airborne += 1;
    },
  });
  return { samples, airborne, waited };
}

/** The client's copy of the cell under the bot is air, the server's is solid: the bot hangs, then a navigate must free it. */
export async function run(context: ScenarioContext): Promise<ClientCompletion> {
  const { holdTicks, cases, openedWindowsAllowed } = requestSchemaIn(context.arena).parse(context.scenario.params);
  const details: string[] = [];
  for (const [index, { target }] of cases.entries()) {
    const start = context.client.body();
    const startY = start.y;
    await context.client.setCell([Math.floor(start.x), Math.floor(start.y - 0.5), Math.floor(start.z)], 0);
    const { samples, airborne, waited } = await sampleHeldBody(context, holdTicks);
    if (waited !== "moved") return { status: "failed", detail: `case ${index}: the server's clock stood still during the ghost-air hold` };
    const held = context.client.body();
    if (airborne < samples / 2 || Math.abs(held.y - startY) >= 0.3)
      return { status: "failed", detail: `case ${index}: the setup did not hold the bot in the air (airborne ${airborne} of ${samples} samples, y ${held.y.toFixed(2)} from ${startY.toFixed(2)})` };
    const [x, y, z] = target;
    const walked = await context.call("navigate", { x, y, z, range: 1, dig: false });
    if (walked.result.status !== "succeeded") return { status: "failed", detail: `case ${index}: the navigate from the held stance read ${walked.result.status}: ${walked.summary}` };
    details.push(`case ${index}: held ${airborne}/${samples} samples over ${holdTicks} server ticks, then ${walked.summary}`);
  }
  const opened = context.client.windowsOpened();
  if (opened > openedWindowsAllowed) return { status: "failed", detail: `the resend opened ${opened} container window(s); ${details.join("; ")}` };
  return { status: "succeeded", detail: details.join("; ") };
}
