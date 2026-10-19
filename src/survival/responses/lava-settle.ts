// After a fire escape: wait until nearby lava has stopped spreading before the interrupted action resumes.
import type { Bot } from "mineflayer";
import { waitForPhysicsTicks } from "../../utils/physics-ticks.js";
import { advancingLavaAt, lavaFlowDelayTicks } from "../../world/lava-flow.js";
import { airSupplyPoints, isInFire, isInLava } from "../perception/body.js";

/** Lava that has not changed for this many flow steps of world age is not spreading any more. */
export const LAVA_SETTLE_FLOW_STEPS = 2;
/** Wall clock bound on the wait: lava still changing after this long is left to the model. */
export const LAVA_SETTLE_MAXIMUM_MS = 10_000;
/** Half the bar: the breath reflex still has time to act, but the lava wait must not use it up. */
const LOW_AIR_POINTS = 10;

/**
 * `settled`: no lava change for two flow steps (or none at all); `spreading`: still changing when the wall clock
 * ended the wait; `endangered`: lava reached the body, damage was taken or air ran low; `died`: death or respawn.
 */
export type LavaSettle = "settled" | "spreading" | "endangered" | "died";

/**
 * Wait, standing on dry ground, until lava near the body has stopped spreading. `lastLavaChangeAge` is the world age
 * of the latest lava change the caller heard of in the volume it watches (null: none). Settled is read from the
 * server's world age, so a server that lags waits longer in real time; the wall clock bounds it either way.
 */
export async function awaitLavaSettled(
  bot: Bot,
  signal: AbortSignal,
  lastLavaChangeAge: () => number | null,
  { maximumMs = LAVA_SETTLE_MAXIMUM_MS }: { maximumMs?: number } = {},
): Promise<LavaSettle> {
  const healthAtStart = bot.health;
  const verdict = (): LavaSettle | null => {
    if (bot.health <= 0) return "died";
    const air = airSupplyPoints(bot);
    if (isInLava(bot) || isInFire(bot) || advancingLavaAt(bot) || bot.health < healthAtStart || (air !== null && air <= LOW_AIR_POINTS))
      return "endangered";
    const last = lastLavaChangeAge();
    return last === null || bot.time.age - last >= LAVA_SETTLE_FLOW_STEPS * lavaFlowDelayTicks(bot) ? "settled" : null;
  };
  // The wall clock and a death end the waits even when physics ticks have stopped (as escapeFire's do).
  const ended = new AbortController();
  const end = () => ended.abort();
  let timedOut = false;
  const wallClock = setTimeout(() => {
    timedOut = true;
    end();
  }, maximumMs);
  bot.once("death", end);
  bot.once("respawn", end);
  const waits = AbortSignal.any([signal, ended.signal]);
  const endedVerdict = (): LavaSettle => verdict() ?? (timedOut ? "spreading" : "died");
  try {
    for (;;) {
      signal.throwIfAborted();
      const now = verdict();
      if (now) return now;
      if (ended.signal.aborted) return endedVerdict();
      await waitForPhysicsTicks(bot, 1, waits);
    }
  } catch (error) {
    signal.throwIfAborted();
    if (!ended.signal.aborted) throw error;
    return endedVerdict();
  } finally {
    clearTimeout(wallClock);
    bot.off("death", end);
    bot.off("respawn", end);
  }
}
