import { setTimeout as sleep } from "node:timers/promises";
import { isInLava } from "../../../src/survival/perception/body.ts";
import { openRuntime, standStill } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";

/** The escape must end within this wall-clock time of the teleport; the server's lava and fire damage race is not checked. */
const ESCAPE_DEADLINE_MS = 5000;
/** Horizontal reach from the teleport cell inside which the bot counts as still near where it started. */
const NEAR_START_BLOCKS = 3;
/** Soul-sand cells end at x = 1; a body centre below this has left the lava overlap. */
const LAVA_OVERLAP_MIN_X = 0.7;
const SOUL_SAND_EDGE_X = 1;

/**
 * Pins the recorded edge overlap (a soul-sand edge touching lava while Mineflayer's swimming flag is false) and the
 * escape from it, not survival. The fixture is peaceful (damage still applies, regeneration ends the burn), so health
 * and burning never decide the verdict.
 */
export const run: MineAiScenario = async (context) => {
  const { bot, signal, log } = context;
  if (!(await standStill(context))) throw new Error("Soul-sand start did not settle.");
  await using runtime = await openRuntime(context, "soul-sand-lava-contact");
  let sawEdge = false;
  let sawFalseSwimmingFlag = false;
  let sawFireOwner = false;
  let died = false;
  const death = () => {
    died = true;
  };
  const observe = () => {
    if (bot.entity.position.x > LAVA_OVERLAP_MIN_X && bot.entity.position.x < SOUL_SAND_EDGE_X) {
      sawEdge = true;
      sawFalseSwimmingFlag ||= Reflect.get(bot.entity, "isInLava") === false;
    }
    sawFireOwner ||= runtime.status().activeAction?.action === "fire_reflex";
  };
  // Observe the teleport packet as well as physics. The reflex can leave the
  // overlap before an awaiting driver's next continuation gets to sample it.
  bot.on("move", observe);
  bot.on("physicsTick", observe);
  bot.on("death", death);
  try {
    const startCell = { x: 0.761841334797, z: 0.5 };
    bot.chat(`/tp @s ${startCell.x} -60.125 ${startCell.z}`);
    const escaped = () => {
      const { x, z } = bot.entity.position;
      const nearStart = Math.hypot(x - startCell.x, z - startCell.z) <= NEAR_START_BLOCKS;
      return (
        sawEdge &&
        sawFalseSwimmingFlag &&
        sawFireOwner &&
        !died &&
        x < LAVA_OVERLAP_MIN_X &&
        nearStart &&
        !isInLava(bot)
      );
    };
    const deadline = performance.now() + ESCAPE_DEADLINE_MS;
    // Polled on the wall clock: physics ticks can stop on a lagging server.
    while (!escaped() && !died && performance.now() < deadline) {
      signal.throwIfAborted();
      await sleep(50, undefined, { signal });
    }
    const detail = JSON.stringify({
      sawEdge,
      sawFalseSwimmingFlag,
      sawFireOwner,
      died,
      lava: isInLava(bot),
      health: bot.health,
      position: bot.entity.position,
    });
    log(detail);
    return { status: escaped() ? "succeeded" : "failed", detail };
  } finally {
    bot.off("move", observe);
    bot.off("physicsTick", observe);
    bot.off("death", death);
  }
};
