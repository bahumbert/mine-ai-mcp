// A real cleanup route yields to fire, resumes safely, and confirms its emergency block on the server.
import { setTimeout as delay } from "node:timers/promises";
import { Vec3 } from "vec3";
import { z } from "zod";
import type { ClientCompletion } from "mine-labs/client";
import { arenaPoint } from "../arena/params.ts";
import type { ScenarioContext } from "../scenario.ts";
import { pendingLifeSavingPlacements, recordLifeSavingPlacement } from "../../../src/world/life-saving-placements.ts";
import { monotonicNow } from "../../../src/utils/monotonic-clock.ts";

/** Hold the arranged body until the fire packet arrives, so a delayed command cannot light the route behind it. */
async function injectFire(context: ScenarioContext): Promise<boolean> {
  context.physics.pause();
  const cell = context.bot.entity.position.floored();
  try {
    context.bot.chat(`/setblock ${cell.x} ${cell.y} ${cell.z} fire`);
    const deadline = monotonicNow() + 2_000;
    while (context.bot.blockAt(cell)?.name !== "fire" && monotonicNow() < deadline) await delay(20);
    return context.bot.blockAt(cell)?.name === "fire";
  } finally {
    context.physics.resume();
  }
}

/** The arranged block stands for a confirmed T5a placement; the runtime's real driver owns all subsequent work. */
export async function run(context: ScenarioContext): Promise<ClientCompletion> {
  const { cell, next } = z.strictObject({ cell: arenaPoint(context.arena), next: arenaPoint(context.arena) }).parse(context.scenario.params);
  const { bot } = context;
  const target = new Vec3(...cell);
  const protectedCell = { x: target.x, y: target.y, z: target.z };
  const region = await context.call("protect_region", {
    corner_a: protectedCell, corner_b: protectedCell, owner: "Builder", label: "cleanup test", reason: "Prove emergency cleanup respects this build.",
  });
  if (region.result.status !== "succeeded") return { status: "failed", detail: region.summary };
  const start = bot.entity.position.clone();
  recordLifeSavingPlacement(bot, target, "block");
  let cleanupSeen = false;
  let injected = false;
  let fireOwned = false;
  let retainedDuringFire = false;
  const deadline = monotonicNow() + 25_000;
  while (monotonicNow() < deadline && bot.health > 0) {
    const status = await context.call("view_status", {});
    const owner = status.survival?.owner.current;
    if (owner === "remove_life_saving_placements") cleanupSeen = true;
    if (cleanupSeen && !injected && bot.entity.position.distanceTo(start) > 0.1) {
      injected = await injectFire(context);
    }
    if (owner === "fire_reflex") {
      fireOwned = true;
      retainedDuringFire ||= pendingLifeSavingPlacements(bot).length === 1 && bot.targetDigBlock == null;
    }
    if (fireOwned && pendingLifeSavingPlacements(bot).length === 0) break;
    await delay(20);
  }
  if (!cleanupSeen || !injected || !fireOwned || !retainedDuringFire || pendingLifeSavingPlacements(bot).length > 0 || bot.blockAt(target)?.type !== 0)
    return { status: "failed", detail: JSON.stringify({ cleanupSeen, injected, fireOwned, retainedDuringFire, pending: pendingLifeSavingPlacements(bot), block: bot.blockAt(target)?.name, health: bot.health }) };
  let serverAir = false;
  const answer = (message: string) => { if (message === "cleanup-server-air") serverAir = true; };
  bot.on("messagestr", answer);
  try {
    bot.chat(`/execute if block ${cell.join(" ")} minecraft:air run tellraw @s {"text":"cleanup-server-air"}`);
    const answerDeadline = monotonicNow() + 2_000;
    while (!serverAir && monotonicNow() < answerDeadline) await delay(20);
  } finally {
    bot.off("messagestr", answer);
  }
  const nextAction = await context.call("navigate", { x: next[0], y: next[1], z: next[2], range: 0, dig: false, scaffold: false });
  return { status: serverAir && nextAction.result.status === "succeeded" ? "succeeded" : "failed",
    detail: JSON.stringify({ cleanupSeen, injected, fireOwned, retainedDuringFire, serverAir, nextAction: nextAction.result.status }) };
}
