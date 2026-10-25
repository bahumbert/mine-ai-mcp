import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { isBurning, isInLava } from "../../../src/survival/perception/body.ts";
import { openRuntime, standStill } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";

/** The escape must end within this wall-clock time of the teleport; the server's lava and fire damage race is not checked. */
const ESCAPE_DEADLINE_MS = 5000;
/** Horizontal reach of the pit step from the teleport cell; a respawn at world spawn is not claimed to be farther. */
const BESIDE_PIT_BLOCKS = 3;

/**
 * Pins the escape, not survival: the reflex places a step in the lava and stands on it within a few seconds.
 * The fixture is peaceful (damage still applies, regeneration ends the burn), so health never decides the verdict.
 */
export const run: MineAiScenario = async (context) => {
  const { bot, signal, log } = context;
  // The pool surface is one below the dry start the scenario file put the bot on.
  const poolY = Math.floor(bot.entity.position.y) - 1;
  assert.ok(await standStill(context));
  await using runtime = await openRuntime(context, "lava-escape-step");
  let died = false;
  let contact = false;
  let claimed = false;
  const death = () => {
    died = true;
  };
  const observe = () => {
    contact ||= isInLava(bot);
    claimed ||= runtime.status().activeAction?.action === "fire_reflex";
  };
  bot.on("death", death);
  bot.on("physicsTick", observe);
  try {
    // No natural bank lies within the reflex's four-block local reach.
    const pitCell = { x: 0.5, z: 0.5 };
    bot.chat(`/tp @s ${pitCell.x} ${poolY} ${pitCell.z}`);
    const deadline = performance.now() + ESCAPE_DEADLINE_MS;
    const escaped = () => {
      const { x, z } = bot.entity.position;
      const besidePit = Math.hypot(x - pitCell.x, z - pitCell.z) <= BESIDE_PIT_BLOCKS;
      return !died && contact && claimed && besidePit && !isInLava(bot) && stepBlockPlaced();
    };
    const stepBlockPlaced = () =>
      bot.findBlock({
        matching: bot.registry.blocksByName.cobblestone!.id,
        maxDistance: BESIDE_PIT_BLOCKS + 1,
      }) !== null;
    // Polled on the wall clock: physics ticks can stop on a lagging server.
    while (!escaped() && !died && performance.now() < deadline) {
      signal.throwIfAborted();
      await sleep(50, undefined, { signal });
    }
    const detail = JSON.stringify({
      died,
      contact,
      claimed,
      stepBlockPlaced: stepBlockPlaced(),
      lava: isInLava(bot),
      burning: isBurning(bot),
      health: bot.health,
      position: bot.entity.position,
    });
    log(detail);
    assert.ok(escaped(), detail);
    return { status: "succeeded", detail };
  } finally {
    bot.off("death", death);
    bot.off("physicsTick", observe);
  }
};
