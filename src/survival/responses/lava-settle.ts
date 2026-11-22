// After a fire escape: wait until nearby lava has stopped spreading before the interrupted action resumes.
import type { Bot } from "mineflayer";
import type { WorldView } from "../../navigation/index.js";
import { waitForPhysicsTicks } from "../../utils/physics-ticks.js";
import { advancingLavaAt, lavaFlowDelayTicks } from "../../world/lava-flow.js";
import { serverPacedSignal } from "../../world/server-paced.js";
import { airSupplyPoints, isBurning, isInFire, isInLava } from "../perception/body.js";
import type { FireEscapeReason } from "../positioning/fire-escape.js";
import { escapeFire, type FireEscapeOptions, type FireEscapeOutcome } from "./fire.js";

/** Lava that has not changed for this many flow steps of world age is not spreading any more. */
export const LAVA_SETTLE_FLOW_STEPS = 2;
/** Server-tick bound on the wait, with wall and stopped-server backstops. */
export const LAVA_SETTLE_MAXIMUM_TICKS = 200;
/** Half the bar: the breath reflex still has time to act, but the lava wait must not use it up. */
const LOW_AIR_POINTS = 10;

/**
 * `settled`: no lava change for two flow steps (or none at all); `spreading`: still changing when the budget
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
  { maximumTicks = LAVA_SETTLE_MAXIMUM_TICKS, budget }: Pick<FireEscapeOptions, "maximumTicks" | "budget"> = {},
): Promise<LavaSettle> {
  using ownedBudget = budget ? null : serverPacedSignal(bot, maximumTicks);
  const limit = budget ?? ownedBudget!;
  const hurt = hurtWatch(bot);
  const verdict = (): LavaSettle | null => {
    if (bot.health <= 0) return "died";
    if (isInLava(bot) || isInFire(bot) || advancingLavaAt(bot)) return "advancing";
    const air = airSupplyPoints(bot);
    if (hurt.hurtSince() || (air !== null && air <= LOW_AIR_POINTS)) return "endangered";
    const last = lastLavaChangeAge();
    return last === null || bot.time.age - last >= LAVA_SETTLE_FLOW_STEPS * lavaFlowDelayTicks(bot) ? "settled" : null;
  };
  const died = new AbortController();
  const end = () => died.abort();
  bot.once("death", end);
  bot.once("respawn", end);
  const ended = AbortSignal.any([died.signal, limit.signal]);
  const waits = AbortSignal.any([signal, ended]);
  const endedVerdict = (): LavaSettle => verdict() ?? (limit.end() !== null ? "spreading" : "died");
  try {
    for (;;) {
      signal.throwIfAborted();
      const now = verdict();
      if (now) return now;
      if (ended.aborted) return endedVerdict();
      await waitForPhysicsTicks(bot, 1, waits);
    }
  } catch (error) {
    signal.throwIfAborted();
    if (!ended.aborted) throw error;
    return endedVerdict();
  } finally {
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

/** Select the current danger for an escape restarted by the settle wait. */
function rerunFireReason(bot: Bot): FireEscapeReason {
  if (advancingLavaAt(bot)) return "advancing_lava";
  return "contact";
}

/**
 * Leave the fire, then wait for nearby lava to settle. Lava that moves at the body during the wait (the settle says
 * `advancing`) runs the escape again, with the reason read from the cells now, inside the same hold and the same
 * server-tick budget: when it is spent, the wait answers `spreading` and the action is returned with a message.
 */
export async function escapeThenSettle(
  bot: Bot,
  world: WorldView,
  signal: AbortSignal,
  reason: FireEscapeReason,
  lastLavaChangeAge: () => number | null,
  { maximumTicks = LAVA_SETTLE_MAXIMUM_TICKS, footing, record }: FireEscapeOptions = {},
): Promise<EscapeAndSettle> {
  let escape = await escapeFire(bot, world, signal, reason, { footing, record });
  if (escape !== "escaped") return { escape, settle: null };
  using budget = serverPacedSignal(bot, maximumTicks);
  for (;;) {
    if (escape !== "escaped") return { escape, settle: null };
    if (budget.end() !== null) return { escape, settle: "spreading" };
    const settle = await awaitLavaSettled(bot, signal, lastLavaChangeAge, { budget });
    if (settle !== "advancing") return { escape, settle };
    if (budget.end() !== null) return { escape, settle: "spreading" };
    escape = await escapeFire(bot, world, signal, rerunFireReason(bot), {
      budget,
      footing, record,
    });
    // A rerun shares the settle budget; expiry out of contact is spreading, not a failed escape (2026-11-18).
    if (escape === "timed_out" && !isInLava(bot) && !isInFire(bot))
      return { escape: "escaped", settle: "spreading" };
  }
}
