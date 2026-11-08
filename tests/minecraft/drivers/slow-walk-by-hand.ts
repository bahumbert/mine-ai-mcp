// Three navigation calls: a slow hand-dug route, the return, and a route with a pickaxe.
import { z } from "zod";
import type { ClientCompletion } from "mine-labs/client";
import { navigateResultSchema } from "../../../src/actions/navigate/contract.ts";
import { arenaActionInput } from "../arena/frame.ts";
import type { ScenarioContext } from "../scenario.ts";

const requestSchema = z.strictObject({
  slow: z.record(z.string(), z.unknown()),
  back: z.record(z.string(), z.unknown()),
  equipped: z.record(z.string(), z.unknown()),
});

export async function run(context: ScenarioContext): Promise<ClientCompletion> {
  const requests = requestSchema.parse(context.scenario.params);
  if (context.bot.inventory.items().length !== 0) return { status: "failed", detail: "Actor did not start empty." };
  const started = performance.now();
  const slow = await context.call("navigate", arenaActionInput(requests.slow, context.arena));
  const elapsed = performance.now() - started;
  const result = navigateResultSchema.safeParse(slow.result);
  if (!result.success || result.data.status !== "failed" || !result.data.error.startsWith("[NAVIGATION_SLOW]") ||
      !result.data.error.includes("pickaxe") || result.data.navigation.digs.byHand < 1 || elapsed > 135_000) {
    return { status: "failed", detail: `slow phase after ${Math.round(elapsed)} ms: ${slow.summary}` };
  }
  const back = await context.call("navigate", arenaActionInput(requests.back, context.arena));
  if (back.result.status !== "succeeded") return { status: "failed", detail: `return: ${back.summary}` };
  await context.waitForTicks(20);
  if (!context.bot.inventory.items().some((item) => item.name === "stone_pickaxe")) {
    return { status: "failed", detail: "Return did not pick up the stone pickaxe." };
  }
  const equipped = await context.call("navigate", arenaActionInput(requests.equipped, context.arena));
  if (equipped.result.status !== "succeeded") return { status: "failed", detail: `pickaxe: ${equipped.summary}` };
  return { status: "succeeded", detail: `slow ${Math.round(elapsed)} ms: ${slow.summary}; return: ${back.summary}; pickaxe: ${equipped.summary}` };
}
