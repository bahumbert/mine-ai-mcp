// A real cleanup route yields to fire, resumes safely, and confirms its emergency block on the server.
import { setTimeout as delay } from "node:timers/promises";
import { Vec3 } from "vec3";
import { z } from "zod";
import type { ClientCompletion } from "mine-labs/client";
import { arenaPoint } from "../arena/params.ts";
import type { ScenarioContext } from "../scenario.ts";
import { pendingLifeSavingPlacements, recordLifeSavingPlacement } from "../../../src/world/life-saving-placements.ts";
import { monotonicNow } from "../../../src/utils/monotonic-clock.ts";
import { SERVER_ANSWER_TICKS, serverTickDeadline } from "../../../src/world/world-age.ts";
import { burnStartNow, waitUntilBodyFree } from "./wait-until-body-free.ts";
import { waitServerTicks } from "./server-ticks.ts";

// Twice the measured 220-tick worst span at 20/10 tps, rounded to a time packet (step D T2d, 2026-11-16).
const CLEANUP_OBSERVE_TICKS = 440;

/** Hold the arranged body until the fire packet arrives, so a delayed command cannot light the route behind it. */
async function injectFire(context: ScenarioContext, sleep: (ms: number) => Promise<void>): Promise<string | null> {
  context.physics.pause();
  const cell = context.bot.entity.position.floored();
  try {
    context.bot.chat(`/setblock ${cell.x} ${cell.y} ${cell.z} fire`);
    const waited = await waitServerTicks(context.bot, SERVER_ANSWER_TICKS, {
      until: () => context.bot.blockAt(cell)?.name === "fire", sleep,
    });
    if (waited === "stalled") return "the server's clock stood still while waiting for the fire block";
    return context.bot.blockAt(cell)?.name === "fire" ? null : "the server did not confirm the fire block within its answer tick budget";
  } finally {
    context.physics.resume();
  }
}

/** The arranged block stands for a confirmed T5a placement; the runtime's real driver owns all subsequent work. */
export async function run(context: ScenarioContext, sleep: (ms: number) => Promise<void> = delay): Promise<ClientCompletion> {
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
  let firedAt = burnStartNow(bot);
  const deadline = serverTickDeadline(() => bot.time?.age, CLEANUP_OBSERVE_TICKS, monotonicNow());
  while (!deadline.passed(monotonicNow()) && bot.health > 0) {
    const status = await context.call("view_status", {});
    const owner = status.survival?.owner.current;
    if (owner === "remove_life_saving_placements") cleanupSeen = true;
    if (cleanupSeen && !injected && bot.entity.position.distanceTo(start) > 0.1) {
      const fireFailure = await injectFire(context, sleep);
      if (fireFailure !== null) return { status: "failed", detail: fireFailure };
      injected = true;
      firedAt = burnStartNow(bot);
    }
    if (owner === "fire_reflex") {
      fireOwned = true;
      retainedDuringFire ||= pendingLifeSavingPlacements(bot).length === 1 && bot.targetDigBlock == null;
    }
    if (fireOwned && pendingLifeSavingPlacements(bot).length === 0) break;
    await sleep(20);
  }
  if (deadline.passed(monotonicNow())) return { status: "failed", detail: (deadline.elapsed(monotonicNow()).ticks ?? 0) >= CLEANUP_OBSERVE_TICKS
    ? `cleanup observation exhausted its ${CLEANUP_OBSERVE_TICKS}-tick budget`
    : "the server's clock stood still while observing cleanup" };
  if (!cleanupSeen || !injected || !fireOwned || !retainedDuringFire || pendingLifeSavingPlacements(bot).length > 0 || bot.blockAt(target)?.type !== 0)
    return { status: "failed", detail: JSON.stringify({ cleanupSeen, injected, fireOwned, retainedDuringFire, pending: pendingLifeSavingPlacements(bot), block: bot.blockAt(target)?.name, health: bot.health }) };
  let serverAir = false;
  const answer = (message: string) => { if (message === "cleanup-server-air") serverAir = true; };
  bot.on("messagestr", answer);
  try {
    bot.chat(`/execute if block ${cell.join(" ")} minecraft:air run tellraw @s {"text":"cleanup-server-air"}`);
    const waited = await waitServerTicks(bot, 40, { until: () => serverAir });
    if (waited === "stalled") return { status: "failed", detail: "the server's clock stood still while waiting for cleanup confirmation" };
  } finally {
    bot.off("messagestr", answer);
  }
  // The fire reflex claims the body again while the bot burns, and a `navigate` on a claim is refused `ACTION_BUSY` (same wait as `lava-pool-region.ts`).
  const bodyFree = await waitUntilBodyFree(context, firedAt);
  if (!bodyFree.freed) return { status: "failed", detail: JSON.stringify({ cleanupSeen, injected, fireOwned, bodyFree }) };
  const nextAction = await context.call("navigate", { x: next[0], y: next[1], z: next[2], range: 0, dig: false, scaffold: false });
  return { status: serverAir && nextAction.result.status === "succeeded" ? "succeeded" : "failed",
    detail: JSON.stringify({ cleanupSeen, injected, fireOwned, retainedDuringFire, serverAir, bodyFree, nextAction: nextAction.result.status }) };
}
