/**
 * A trace of one toss for the hand-over drivers' `trace` mode (plan 2026-11-08-trading-p2-fixes Task 3.1, spec D5): the giver's
 * feet, velocity and look, and every item entity near it, every 5 ticks from the `drop_item` call until 60 ticks after its answer,
 * and who collected an item. Lines are `TOSS_TRACE ...`; the driver puts them in its completion detail.
 */
import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import { isItemEntity } from "../../../src/world/item-pickup.ts";

/** Ticks between two samples. */
const SAMPLE_EVERY_TICKS = 5;
/** Ticks the trace goes on after the call answered: the pickup delay of a toss is 40, so 60 shows the item picked up or at rest. */
const AFTER_ANSWER_TICKS = 60;
/** Items farther than this from the giver are another toss's. */
const ITEM_RADIUS = 6;
/** A call that never answers stops being sampled here (ticks), so the detail stays bounded. */
const MAX_TRACED_TICKS = 2_000;

export interface TraceClock {
  readonly bot: Bot;
  waitForTicks(ticks: number): Promise<void>;
}

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
 * Run `call` while sampling; the call's value (or its error, with the collect listener removed) and the trace lines.
 * `every` is the ticks between two samples: 1 shows the ticks around a toss that leaves between two default samples.
 * A `collected` line is stamped with the last sample taken (the event is somewhere between it and the next): the world age
 * (`bot.time.age`) moves in jumps of 20 ticks, and so is no clock for it.
 */
export async function traceToss<T>(clock: TraceClock, call: () => Promise<T>, every: number = SAMPLE_EVERY_TICKS): Promise<{ value: T; lines: string[] }> {
  const { bot } = clock;
  const lines: string[] = [];
  let answered = false;
  let sampled = 0;
  const onCollect = (collector: Entity, collected: Entity): void => {
    const tick = Math.max(0, sampled - 1) * every;
    lines.push(`TOSS_TRACE t=${tick} collected by=${(collector as Entity & { username?: string }).username ?? collector.name ?? collector.id} item=${collected.id}`);
  };
  bot.on("playerCollect", onCollect);
  const sampler = (async () => {
    while (!answered && sampled * every < MAX_TRACED_TICKS) {
      lines.push(...sample(bot, sampled * every));
      sampled += 1;
      await clock.waitForTicks(every);
    }
  })();
  // A sample that cannot be read (the body is gone) rejects here: the call's own error wins when it ended first, and `await sampler` below rethrows it when the call went well.
  sampler.catch(() => undefined);
  try {
    const value = await call();
    answered = true;
    await sampler;
    for (let after = 0; after < AFTER_ANSWER_TICKS; after += every) {
      lines.push(...sample(bot, sampled * every));
      sampled += 1;
      await clock.waitForTicks(every);
    }
    return { value, lines };
  } finally {
    answered = true;
    bot.off("playerCollect", onCollect);
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
