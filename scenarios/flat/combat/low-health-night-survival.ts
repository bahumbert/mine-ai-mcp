/** Judge survival under real pressure; the production runtime chooses its response. */
import type { ClientCompletion } from "mine-labs/client";
import { z } from "zod";
import { type ServerPacedEnd, serverPacedElapsed, waitForServerPaced } from "../../../src/world/server-paced.ts";
import type { MineAiScenarioContext } from "../../src/scenario-client.ts";
import { openAtArrangedHealth } from "./arranged-health.ts";

const paramsSchema = z.strictObject({ startingHealth: z.number().int().min(1).max(20) });

/** A death ends the attempt immediately, even if Mineflayer subsequently respawns. */
export async function observeSurvival(
  context: MineAiScenarioContext,
  seconds: number,
): Promise<"survived" | "died" | "cancelled" | "stalled" | "wall" | "unobserved"> {
  const { bot, signal } = context;
  if (signal.aborted) return "cancelled";
  if (bot.health <= 0) return "died";
  const death = new AbortController();
  let died = false;
  const onDeath = () => { died = true; death.abort(); };
  bot.once("death", onDeath);
  try {
    const end = await waitForServerPaced(bot, seconds * 20, {
      until: () => died || bot.health <= 0,
      signal: AbortSignal.any([signal, death.signal]),
    });
    return end === "ticks" ? "survived" : end === "until" ? "died" : end;
  } catch (error) {
    if (died) return "died";
    if (signal.aborted) return "cancelled";
    throw error;
  } finally {
    bot.off("death", onDeath);
  }
}

/** Observe declared nearby threats and retain the bounded server-clock wait's evidence. */
async function observeThreats(context: MineAiScenarioContext) {
  const { bot } = context;
  // The host has already observed the player's position and inventory. Mobs
  // activate at start, so wait only for their spawn packets before judging setup.
  const expected = new Map<string, number>();
  for (const entity of context.scenario.entities) {
    const type = entity.type.replace(/^minecraft:/, "");
    expected.set(type, (expected.get(type) ?? 0) + 1);
  }
  const threats = [...expected].map(([type, count]) => `${count} ${type}`).join(", ");
  const elapsed = serverPacedElapsed(bot);
  const end = await waitForServerPaced(bot, 40, { signal: context.signal, until: () => {
    const nearby = Object.values(bot.entities).filter((entity) => entity.position.distanceTo(bot.entity.position) < 16);
    return [...expected].every(([type, count]) => nearby.filter((entity) => entity.name === type).length === count);
  } });
  return { threats, end, elapsed: JSON.stringify(elapsed()) };
}

/** Explain why a clock backstop could not confirm the survival window. */
function clockFailure(end: Exclude<ServerPacedEnd, "ticks">): string {
  switch (end) {
    case "stalled": return "server clock stood still";
    case "wall": return "wall backstop";
    case "unobserved": return "no world age heard";
  }
}

export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  const { bot } = context;
  const { startingHealth } = paramsSchema.parse(context.scenario.params);
  const goal = context.scenario.goal;
  const survival = goal.kind === "all" ? goal.goals.find((child) => child.kind === "survive") : undefined;
  if (!survival || survival.kind !== "survive") throw new Error("This driver requires a declared survive goal");
  const setup = await observeThreats(context);
  if (setup.end !== "until") return { status: "failed",
    detail: `Setup failed: the declared threats were not observed (${setup.threats}); ${setup.end}; ${setup.elapsed}` };
  const runtime = await openAtArrangedHealth(context, startingHealth, "low-health-night-survival");
  try {
    context.log(`Survival window started: ${survival.seconds}s, health ${bot.health}, ${setup.threats}; any strategy allowed`);
    const elapsed = serverPacedElapsed(bot);
    const outcome = await observeSurvival(context, survival.seconds);
    const reason = outcome === "stalled" || outcome === "wall" || outcome === "unobserved" ? `; ${clockFailure(outcome)}` : "";
    return {
      status: outcome === "survived" ? "succeeded" : "failed",
      detail: `${outcome}${reason}; ${survival.seconds}s survival window; final health ${bot.health}; ${JSON.stringify(elapsed())}`,
    };
  } finally {
    await runtime.close();
  }
}
