/**
 * A trace of one toss for the hand-over drivers' `trace` mode (plan 2026-11-08-trading-p2-fixes Task 3.1, spec D5): the giver's
 * feet, velocity and look, and every item entity near it, every 5 physics ticks from the `drop_item` call until 60 server ticks
 * after its answer, and who collected an item. Lines are `TOSS_TRACE ...`; the driver puts them in its completion detail.
 * The bot's physics tick is only the cadence of a sample (its client ticks 20 a second at any server rate); what ends the trace is
 * the server's world age (plan 2026-11-22-phase5-gate-p1 T17, skill `add-scenario-test` S1).
 */
import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import { monotonicNow } from "../../../src/utils/monotonic-clock.ts";
import { isItemEntity } from "../../../src/world/item-pickup.ts";
import { STALE_AGE_TICKS, waitForWorldAge } from "../../../src/world/world-age.ts";
import { DRIVER_CLOCK_STOPPED_MS } from "./server-ticks.ts";

/** Physics ticks between two samples. */
const SAMPLE_EVERY_TICKS = 5;
/** Server ticks the trace goes on after the call answered: the pickup delay of a toss is 40, so 60 shows the item picked up or at rest. */
const AFTER_ANSWER_TICKS = 60;
/** Items farther than this from the giver are another toss's. */
const ITEM_RADIUS = 6;
/** A call that never answers stops being sampled after this many server ticks from the start, so the detail stays bounded. */
const MAX_TRACED_SERVER_TICKS = 2_000;

const fixed = (value: number): string => value.toFixed(2);
const triple = (x: number, y: number, z: number): string => `${fixed(x)} ${fixed(y)} ${fixed(z)}`;

function sample(bot: Bot, tick: number): string[] {
  const { position, velocity, onGround, yaw, pitch } = bot.entity;
  const lines = [`TOSS_TRACE t=${tick} giver=${triple(position.x, position.y, position.z)} vel=${triple(velocity.x, velocity.y, velocity.z)} onGround=${onGround} yaw=${fixed(yaw)} pitch=${fixed(pitch)}`];
  for (const item of nearbyItems(bot)) {
    lines.push(`TOSS_TRACE t=${tick} item=${item.id} at=${triple(item.position.x, item.position.y, item.position.z)} vel=${triple(item.velocity.x, item.velocity.y, item.velocity.z)}`);
  }
  return lines;
}

function nearbyItems(bot: Bot): Entity[] {
  return Object.values(bot.entities).filter((entity) => isItemEntity(entity) && entity.position.distanceTo(bot.entity.position) <= ITEM_RADIUS);
}

/**
 * Run `call` while sampling; the call's value (or its error, with the listeners removed) and the trace lines.
 * `every` is the physics ticks between two samples (the `t=` of a line counts them from the start): 1 shows the ticks around a
 * toss that leaves between two default samples. A sample is taken on the bot's `physicsTick`, no wait. The trace goes on until
 * the world age (`bot.time.age`) is at least `AFTER_ANSWER_TICKS` server ticks past the answer (61 to 80: the cached age is up to
 * 19 ticks old and moves in jumps of 20), or ends at the stalled-clock bound (`DRIVER_CLOCK_STOPPED_MS`, with a line saying so);
 * a call that never answers is sampled for `MAX_TRACED_SERVER_TICKS` only, or until the world age stood still that long.
 * A `collected` line is stamped with the last sample taken (the event is somewhere between it and the next): the world age
 * moves in jumps of 20 ticks, and so is no clock for it.
 */
export async function traceToss<T>(bot: Bot, call: () => Promise<T>, every: number = SAMPLE_EVERY_TICKS): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  let answered = false;
  let physicsTicks = 0;
  let lastSampleTick = 0;
  let startAge = bot.time?.age ?? undefined;
  // A sample that cannot be read (the body is gone) is kept here: the call's own error wins when it ended first, and it is rethrown when the call went well.
  const unreadable: { error?: unknown } = {};
  let lastAge = startAge;
  let lastAgeMoveAt = monotonicNow();
  const pastCap = (): boolean => {
    const age = bot.time?.age ?? undefined;
    startAge ??= age;
    if (age !== lastAge) [lastAge, lastAgeMoveAt] = [age, monotonicNow()];
    // wall bound: the cap counts server ticks, and a world age that stands still never reaches it (a stopped server); the stalled-clock bound of every driver wait ends it.
    return (startAge !== undefined && age !== undefined && age - startAge >= MAX_TRACED_SERVER_TICKS) || monotonicNow() - lastAgeMoveAt >= DRIVER_CLOCK_STOPPED_MS;
  };
  const takeSample = (): void => {
    try {
      lines.push(...sample(bot, physicsTicks));
      lastSampleTick = physicsTicks;
    } catch (error) {
      unreadable.error = error;
    }
  };
  const onTick = (): void => {
    physicsTicks += 1;
    if (physicsTicks % every === 0 && !("error" in unreadable) && (answered || !pastCap())) takeSample();
  };
  const onCollect = (collector: Entity, collected: Entity): void => {
    lines.push(`TOSS_TRACE t=${lastSampleTick} collected by=${(collector as Entity & { username?: string }).username ?? collector.name ?? collector.id} item=${collected.id}`);
  };
  bot.on("playerCollect", onCollect);
  bot.on("physicsTick", onTick);
  try {
    takeSample();
    const value = await call();
    answered = true;
    if ("error" in unreadable) throw unreadable.error;
    // The cached age is up to `STALE_AGE_TICKS` old: the margin keeps the trace from ending short of its server ticks.
    const end = await waitForWorldAge(bot, AFTER_ANSWER_TICKS + STALE_AGE_TICKS, { wallMs: Number.POSITIVE_INFINITY, stallMs: DRIVER_CLOCK_STOPPED_MS, until: () => "error" in unreadable });
    if ("error" in unreadable) throw unreadable.error;
    if (end === "stalled") lines.push(`TOSS_TRACE world age stood still for ${DRIVER_CLOCK_STOPPED_MS} ms: the trace ends`);
    return { value, lines };
  } finally {
    answered = true;
    bot.off("physicsTick", onTick);
    bot.off("playerCollect", onCollect);
  }
}

/** How a `pollWithinServerTicks` ended without a find: its server-tick budget passed, or the world age stood still (the server stopped). */
export type PollEnd = "budget" | "stalled";

/**
 * Look with `look` at once, then once every `everyPhysicsTicks` of the bot's physics ticks (a cadence: the client ticks 20 a second
 * at any server rate), until it returns a value (`found`), or the world age is `budgetTicks` server ticks past the start, or the age
 * stood still for `DRIVER_CLOCK_STOPPED_MS` (`ended`). One last look is taken at the end, so a value that appeared by then is found.
 * Looks never overlap. A look that throws ends the poll with its error. The budget never ends early: the cached age is up to
 * `STALE_AGE_TICKS` old, so the wait adds that margin (the same as `waitServerTicks`, which also rounds up to whole 20-tick packets).
 */
export async function pollWithinServerTicks<T>(bot: Bot, budgetTicks: number, everyPhysicsTicks: number, look: () => Promise<T | undefined>): Promise<{ found: T } | { ended: PollEnd }> {
  const state: { found?: T; failure?: { error: unknown }; looking?: Promise<void> } = {};
  let physicsTicksSinceLook = everyPhysicsTicks;
  const onTick = (): void => void (physicsTicksSinceLook += 1);
  const lookOnce = (): Promise<void> => {
    physicsTicksSinceLook = 0;
    return look().then((value) => { state.found = value; }, (error: unknown) => { state.failure = { error }; });
  };
  const looked = (): boolean => state.found !== undefined || state.failure !== undefined;
  bot.on("physicsTick", onTick);
  try {
    const end = await waitForWorldAge(bot, budgetTicks + STALE_AGE_TICKS, {
      wallMs: Number.POSITIVE_INFINITY,
      stallMs: DRIVER_CLOCK_STOPPED_MS,
      until: () => {
        if (looked()) return true;
        if (state.looking === undefined && physicsTicksSinceLook >= everyPhysicsTicks) {
          state.looking = lookOnce().finally(() => void (state.looking = undefined));
        }
        return false;
      },
    });
    await state.looking;
    if (!looked()) await lookOnce();
    if (state.failure) throw state.failure.error;
    return state.found !== undefined ? { found: state.found } : { ended: end === "stalled" ? "stalled" : "budget" };
  } finally {
    bot.off("physicsTick", onTick);
  }
}

/** Where the nearest item entity lies from the bot's feet (height difference and horizontal distance), for a measurement that ends with the item at rest. */
export function describeRest(bot: Bot): string {
  const [nearest] = nearbyItems(bot).sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));
  if (!nearest) return "no item seen";
  const dist = Math.hypot(nearest.position.x - bot.entity.position.x, nearest.position.z - bot.entity.position.z);
  const { position: me } = bot.entity;
  return `rest_dy=${fixed(nearest.position.y - me.y)} rest_dist=${fixed(dist)} me=${triple(me.x, me.y, me.z)} item=${triple(nearest.position.x, nearest.position.y, nearest.position.z)}`;
}
