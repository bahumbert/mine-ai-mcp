import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { viewStatusResultSchema } from "@aibengineering/mine-ai-mcp";
import type { ClientCompletion } from "mine-labs/client";
import { arenaPoint } from "../arena/params.ts";
import type { ScenarioContext } from "../scenario.ts";
import { isBurning, isInLava } from "../../../src/survival/perception/body.ts";
import { monotonicNow } from "../../../src/utils/monotonic-clock.ts";

const paramsIn = (arena: ScenarioContext["arena"]) =>
  z.strictObject({
    /** The feet cell on the pool's floor the actor is teleported to (world coordinates once read). */
    poolFloor: arenaPoint(arena),
    /** Cells from the pool floor to the feet height of the bank around it. */
    bankRise: z.number().int().positive(),
    /** The escape must end within this many wall-clock ms of the teleport. */
    deadlineMs: z.number().int().positive(),
    /** Absorption amplifier given before the teleport: a margin so the lava race never decides the verdict (0: none). */
    absorptionAmplifier: z.number().int().min(0),
  });

const POLL_MS = 100;
const FIRE_REFLEX = "fire_reflex";

/**
 * A bot dropped on the floor of a lava pool deeper than the one-cell bank reach, with nothing to build with or with a
 * few blocks: the fire reflex must own the body for the whole swim up (no stand-down between its claims while in
 * lava) and the body must end out of the lava on the bank within the bound. A death after that does not fail it
 * (lava and fire still hurt on a peaceful server): only the escape is checked, never survival by luck.
 */
export async function run(context: ScenarioContext): Promise<ClientCompletion> {
  const params = paramsIn(context.arena).parse(context.scenario.params);
  const [floorX, floorY, floorZ] = params.poolFloor;
  const { bot } = context;
  let died = false;
  let contact = false;
  let hitsTaken = 0;
  let lastHealth = bot.health;
  const onDeath = () => {
    died = true;
  };
  const onHealth = () => {
    if (bot.health < lastHealth) hitsTaken++;
    lastHealth = bot.health;
  };
  let ticksInLava = 0;
  const onTick = () => {
    if (isInLava(bot)) {
      contact = true;
      ticksInLava++;
    }
  };
  bot.on("death", onDeath);
  bot.on("health", onHealth);
  bot.on("physicsTick", onTick);
  try {
    if (params.absorptionAmplifier > 0) bot.chat(`/effect give @s minecraft:absorption 120 ${params.absorptionAmplifier} true`);
    await context.waitForTicks(5);
    lastHealth = bot.health;
    bot.chat(`/tp @s ${floorX} ${floorY} ${floorZ}`);
    const startedAt = monotonicNow();
    let claimed = false;
    let lostInLava = 0;
    const onBank = () => !isInLava(bot) && bot.entity.onGround && bot.entity.position.y >= floorY + params.bankRise - 0.05;
    const escaped = () => contact && claimed && onBank();
    // Polled on the wall clock: physics ticks can stop on a lagging server.
    while (!escaped() && !died && monotonicNow() - startedAt < params.deadlineMs) {
      const status = viewStatusResultSchema.parse((await context.call("view_status", {})).result);
      const owner = status.status === "succeeded" ? status.situation.activity.activeAction?.action : undefined;
      if (owner === FIRE_REFLEX) claimed = true;
      else if (claimed && isInLava(bot)) lostInLava++;
      await delay(POLL_MS);
    }
    const position = bot.entity.position;
    const detail = JSON.stringify({
      escapedAfterMs: Math.round(monotonicNow() - startedAt),
      ticksInLava,
      hitsTaken,
      died,
      contact,
      claimed,
      lostInLava,
      burning: isBurning(bot),
      health: bot.health,
      position: { x: position.x, y: position.y, z: position.z },
    });
    if (!escaped()) return { status: "failed", detail: `the body did not end on the bank in time: ${detail}` };
    if (lostInLava > 0) return { status: "failed", detail: `the fire reflex lost the body ${lostInLava} time(s) while it was in lava: ${detail}` };
    return { status: "succeeded", detail };
  } finally {
    bot.off("death", onDeath);
    bot.off("health", onHealth);
    bot.off("physicsTick", onTick);
  }
}
