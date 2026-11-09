// A real foreign-region lava step must be placed, escaped from and removed before the next action.
import { setTimeout as delay } from "node:timers/promises";
import { Vec3 } from "vec3";
import { z } from "zod";
import type { ClientCompletion } from "mine-labs/client";
import { arenaPoint } from "../arena/params.ts";
import type { ScenarioContext } from "../scenario.ts";
import { pendingLifeSavingPlacements } from "../../../src/world/life-saving-placements.ts";
import { monotonicNow } from "../../../src/utils/monotonic-clock.ts";
import { run as escapePool } from "./lava-pool-escape.ts";

/** Require the server's answer, rather than Mineflayer's predicted air after digging. */
async function serverRemoved(context: ScenarioContext, cells: readonly Vec3[]): Promise<boolean> {
  const confirmed = new Set<string>();
  const answer = (message: string) => { if (message.startsWith("pool-air-")) confirmed.add(message); };
  context.bot.on("messagestr", answer);
  try {
    cells.forEach((cell, index) => context.bot.chat(`/execute if block ${cell.x} ${cell.y} ${cell.z} minecraft:air run tellraw @s {"text":"pool-air-${index}"}`));
    const deadline = monotonicNow() + 2_000;
    while (confirmed.size < cells.length && monotonicNow() < deadline) await delay(20);
    return confirmed.size === cells.length;
  } finally {
    context.bot.off("messagestr", answer);
  }
}

/** The existing pool driver proves the escape; this wrapper proves the placement debt and the next action. */
export async function run(context: ScenarioContext): Promise<ClientCompletion> {
  const params = z.strictObject({
    regionMin: arenaPoint(context.arena), regionMax: arenaPoint(context.arena), next: arenaPoint(context.arena),
    gateMin: arenaPoint(context.arena), gateMax: arenaPoint(context.arena),
    escape: z.record(z.string(), z.unknown()),
  }).parse(context.scenario.params);
  const corner = ([x, y, z]: number[]) => ({ x, y, z });
  const region = await context.call("protect_region", {
    corner_a: corner(params.regionMin), corner_b: corner(params.regionMax), owner: "Builder", label: "lava pool",
    reason: "Emergency placements must be removed after escaping this pool.",
  });
  if (region.result.status !== "succeeded") return { status: "failed", detail: region.summary };
  const seen = new Map<string, Vec3>();
  let opened = false;
  const observe = () => {
    for (const entry of pendingLifeSavingPlacements(context.bot)) {
      if (entry.kind === "block" && context.bot.blockAt(entry.cell)?.name === entry.block) seen.set(String(entry.cell), entry.cell.clone());
    }
    if (!opened && seen.size > 0) {
      opened = true;
      context.bot.chat(`/fill ${params.gateMin.join(" ")} ${params.gateMax.join(" ")} minecraft:air replace minecraft:stone`);
    }
  };
  context.bot.on("blockUpdate", observe);
  context.bot.on("physicsTick", observe);
  try {
    const escape = await escapePool({ ...context, scenario: { ...context.scenario, params: params.escape } });
    if (escape.status !== "succeeded") return escape;
    const deadline = monotonicNow() + 30_000;
    while (pendingLifeSavingPlacements(context.bot).length > 0 && monotonicNow() < deadline) await delay(50);
    const cells = [...seen.values()];
    const removed = cells.length > 0 && pendingLifeSavingPlacements(context.bot).length === 0 && await serverRemoved(context, cells);
    if (!removed) return { status: "failed", detail: JSON.stringify({ escape, placed: cells, pending: pendingLifeSavingPlacements(context.bot) }) };
    const [x, y, z] = params.next;
    const next = await context.call("navigate", { x, y, z, range: 0, dig: false, scaffold: false });
    return { status: next.result.status === "succeeded" ? "succeeded" : "failed", detail: JSON.stringify({ escape, placed: cells, serverRemoved: removed, next: next.result.status }) };
  } finally {
    context.bot.off("blockUpdate", observe);
    context.bot.off("physicsTick", observe);
  }
}
