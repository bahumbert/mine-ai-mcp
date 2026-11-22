import type { Bot } from "mineflayer";
import { isDrawingBow } from "./attention.js";
import { serverTickPace, type TickMark } from "../../../world/server-tick-pace.js";
import { MS_PER_ON_TIME_TICK } from "../../../world/world-age.js";
import { monotonicNow } from "../../../utils/index.js";

type Draw = { entity: Bot["entity"]; active: boolean; started: TickMark | null };
const readers = new WeakMap<Bot, (entity: Bot["entity"]) => Draw | undefined>();

/** Unknown starts are already potentially due. This is release timing, not a guaranteed shot. */
export function bowReleaseInTicks(bot: Bot, entity: Bot["entity"]): number | null {
  const draw = readers.get(bot)?.(entity);
  return draw?.started && draw.started.age !== null ? Math.max(0, Math.ceil(20 - serverTickPace(bot).creditedSince(draw.started))) : null;
}

/** Readiness credit errs late; incoming admission also needs the fastest possible elapsed draw. */
export function earliestBowRelease(bot: Bot, entity: Bot["entity"], now = monotonicNow()) {
  const started = readers.get(bot)?.(entity)?.started;
  if (!started) return { ticks: 0, uncertain: true };
  const pace = serverTickPace(bot), elapsed = Math.max(0, now - started.ms);
  return { ticks: Math.max(0, 20 - elapsed / MS_PER_ON_TIME_TICK),
    uncertain: started.age === null || pace.creditedSince(started, now) + 1e-6 < elapsed / pace.msPerTick() };
}

/** Observe metadata transitions independently of how frequently combat decisions read them. */
export function trackBowDraws(bot: Bot): Disposable {
  const draws = new Map<number, Draw>();
  const pace = serverTickPace(bot);
  const observe = () => {
    for (const entity of Object.values(bot.entities)) {
      if (!["skeleton", "stray", "bogged"].includes(entity.name ?? "")) continue;
      const previous = draws.get(entity.id);
      const index = bot.registry.entitiesByName[entity.name ?? ""]?.metadataKeys?.indexOf("living_entity_flags") ?? 8;
      const flags: unknown = entity.metadata?.[index];
      if (typeof flags !== "number") continue;
      // Equipment may arrive after metadata. That must not manufacture a new draw start.
      const active = (flags & 1) !== 0;
      draws.set(entity.id, { entity, active, started: !active ? null
        : previous?.entity !== entity ? null : !previous.active ? pace.mark() : previous.started });
    }
  };
  const gone = (entity: Bot["entity"]) => { draws.delete(entity.id); };
  const clear = () => draws.clear();
  const read = (entity: Bot["entity"]) => {
    const draw = draws.get(entity.id);
    return draw?.entity === entity && draw.active && isDrawingBow(bot, entity) ? draw : undefined;
  };
  observe();
  readers.set(bot, read);
  bot.on("physicsTick", observe);
  bot.on("entityUpdate", observe);
  bot.on("entityGone", gone);
  bot.on("respawn", clear);
  return { [Symbol.dispose]() {
    bot.off("physicsTick", observe);
    bot.off("entityUpdate", observe);
    bot.off("entityGone", gone);
    bot.off("respawn", clear);
    if (readers.get(bot) === read) readers.delete(bot);
  } };
}
