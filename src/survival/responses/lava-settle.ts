// After a fire escape: wait until nearby lava has stopped spreading before the interrupted action resumes.
import type { Bot } from "mineflayer";
import type { WorldView } from "../../navigation/index.js";
import { waitForPhysicsTicks } from "../../utils/physics-ticks.js";
import { advancingLavaAt, lavaFlowDelayTicks } from "../../world/lava-flow.js";
import { airSupplyPoints, isBurning, isInFire, isInLava } from "../perception/body.js";
import type { FireEscapeReason } from "../positioning/fire-escape.js";
import { escapeFire, type FireEscapeOutcome } from "./fire.js";

/** Lava that has not changed for this many flow steps of world age is not spreading any more. */
export const LAVA_SETTLE_FLOW_STEPS = 2;
/** Wall clock bound on the wait: lava still changing after this long is left to the model. */
export const LAVA_SETTLE_MAXIMUM_MS = 10_000;
/** Half the bar: the breath reflex still has time to act, but the lava wait must not use it up. */
const LOW_AIR_POINTS = 10;

/**
 * `settled`: no lava change for two flow steps (or none at all); `spreading`: still changing when the wall clock
 * ended the wait; `advancing`: lava is in the body or can spread into it on its next step (the escape runs again);
 * `endangered`: damage other than the burn was taken or air ran low; `died`: death or respawn.
 */
export type LavaSettle = "settled" | "spreading" | "advancing" | "endangered" | "died";

/**
 * Health lost since the wait began, minus what the burn explains: burning on dry ground with no water costs about 1 HP
 * a second for up to 15 s after a lava contact, and that is no new danger. Health lost with no fire on the body (or
 * one sample after it went out), and a hit that names an attacker, are.
 */
function hurtWatch(bot: Bot) {
  let baseline = bot.health;
  let wasBurning = isBurning(bot);
  let hit = false;
  const onHurt = (entity: unknown, source: unknown) => {
    if (entity === bot.entity && source) hit = true;
  };
  bot.on("entityHurt", onHurt);
  return {
    hurtSince(): boolean {
      const burning = isBurning(bot);
      const burnExplains = burning || wasBurning;
      wasBurning = burning;
      if (hit) return true;
      if (bot.health > baseline || (bot.health < baseline && burnExplains)) baseline = bot.health;
      return bot.health < baseline;
    },
    stop: () => bot.off("entityHurt", onHurt),
  };
}

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
  const hurt = hurtWatch(bot);
  const verdict = (): LavaSettle | null => {
    if (bot.health <= 0) return "died";
    if (isInLava(bot) || isInFire(bot) || advancingLavaAt(bot)) return "advancing";
    const air = airSupplyPoints(bot);
    if (hurt.hurtSince() || (air !== null && air <= LOW_AIR_POINTS)) return "endangered";
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
    hurt.stop();
    bot.off("death", end);
    bot.off("respawn", end);
  }
}

/** What `escapeThenSettle` ended with: the escape's outcome and, when it escaped, how the wait for the lava ended. */
export interface EscapeAndSettle {
  readonly escape: FireEscapeOutcome;
  readonly settle: Exclude<LavaSettle, "advancing"> | null;
}

/**
 * Leave the fire, then wait for nearby lava to settle. Lava that moves at the body during the wait (the settle says
 * `advancing`) runs the escape again, with the reason read from the cells now, inside the same hold and the same
 * `maximumMs` clock: when the clock is out, the wait answers `spreading` and the action is returned with a message.
 */
export async function escapeThenSettle(
  bot: Bot,
  world: WorldView,
  signal: AbortSignal,
  reason: FireEscapeReason,
  lastLavaChangeAge: () => number | null,
  { maximumMs = LAVA_SETTLE_MAXIMUM_MS }: { maximumMs?: number } = {},
): Promise<EscapeAndSettle> {
  let escape = await escapeFire(bot, world, signal, reason);
  const deadline = performance.now() + maximumMs;
  for (;;) {
    if (escape !== "escaped") return { escape, settle: null };
    const left = deadline - performance.now();
    if (left <= 0) return { escape, settle: "spreading" };
    const settle = await awaitLavaSettled(bot, signal, lastLavaChangeAge, { maximumMs: left });
    if (settle !== "advancing") return { escape, settle };
    const leftToEscape = deadline - performance.now();
    if (leftToEscape <= 0) return { escape, settle: "spreading" };
    escape = await escapeFire(bot, world, signal, advancingLavaAt(bot) ? "advancing_lava" : "contact", {
      maximumMs: leftToEscape,
    });
  }
}
