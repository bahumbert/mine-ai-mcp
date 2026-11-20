import type { Bot } from "mineflayer";
import { botEyesInWater } from "./eyes-in-water.js";
import { SERVER_ANSWER_TICKS } from "./world-age.js";

/** A full meter: what a body that was never under water has (`LivingEntity.getMaxAirSupply`). */
const FULL_AIR_TICKS = 300;

/**
 * What one body (a login or a respawn starts a new one) has shown since the tracker attached. The server sends the air
 * only when it changes (contract check `air-supply-under-water`), so a body that stayed out of water and reported
 * nothing has the default.
 */
interface AirHistory {
  /** A `login` or `respawn` was seen: the body this history describes exists. */
  started: boolean;
  /** The eyes were under water at some tick or time packet of this body. */
  wet: boolean;
  /** This body reported its own air at some point (the value may have been cleared since without a respawn). */
  reported: boolean;
  /** The world age of the first time packet heard after the body started. */
  firstAge: number | null;
}

const histories = new WeakMap<Bot, AirHistory>();

/** The bot's own `air_supply` metadata as filed: undefined when the server has sent none. Never another entity's, never `oxygenLevel`. */
function ownAirMetadata(bot: Bot): unknown {
  const index = bot.registry.entitiesByName.player?.metadataKeys?.indexOf("air_supply") ?? -1;
  return index < 0 ? undefined : bot.entity?.metadata?.[index];
}

/**
 * Follow the bot's whole life so its air can be known when the server never sent it (a bot that stayed on land has no
 * `air_supply` metadata: the server sends it only when it changes). Install it once, before the connection, beside the
 * other watchers; a bot with no tracker keeps the reported value only.
 */
export function watchAirHistory(bot: Bot): void {
  if (histories.has(bot)) return;
  const history: AirHistory = { started: false, wet: false, reported: false, firstAge: null };
  histories.set(bot, history);
  const startBody = () => void Object.assign(history, { started: true, wet: false, reported: false, firstAge: null });
  // `login` makes a new entity (`entities.js:100-105`); `respawn` clears the metadata unless the packet keeps it (`:115-122`).
  const watch = () => {
    if (!bot.entity) return;
    if (ownAirMetadata(bot) !== undefined) history.reported = true;
    if (botEyesInWater(bot)) history.wet = true;
  };
  const heardTime = () => {
    watch();
    if (history.started && history.firstAge === null && typeof bot.time?.age === "number") history.firstAge = bot.time.age;
  };
  // A bot that has ended is gone for good: the host's disposal leaves no listener behind (`runtime-host.test.ts`).
  const stop = () => {
    bot.off("login", startBody);
    bot.off("respawn", startBody);
    bot.off("physicsTick", watch);
    bot.off("time", heardTime);
    bot.off("end", stop);
    histories.delete(bot);
  };
  bot.on("login", startBody);
  bot.on("respawn", startBody);
  bot.on("physicsTick", watch);
  bot.on("time", heardTime);
  bot.on("end", stop);
}

/**
 * Server-owned air in ticks: the value the server reported, else 300 when the body provably never lost any, else null.
 * Full air is known when all four hold: the bot's own metadata is absent; a login or respawn was seen and this body
 * has reported nothing since; its eyes were never under water since (at a tick or time packet, or now); and the world
 * age moved `SERVER_ANSWER_TICKS` since the first time packet heard after that moment (a wait is not a server answer:
 * the spawn's metadata packets are handled first). A present value that is not an integer is unknown, never full.
 */
export function airSupplyTicks(bot: Bot): number | null {
  const value = ownAirMetadata(bot);
  const history = histories.get(bot);
  if (value !== undefined) {
    if (history) history.reported = true;
    return typeof value === "number" && Number.isInteger(value) ? value : null;
  }
  if (!history) return null;
  // A read at the call that sees the head under water is an observation like a tick's: the body stays wet.
  if (bot.entity && botEyesInWater(bot)) history.wet = true;
  if (!history.started || history.wet || history.reported || history.firstAge === null) return null;
  const age = bot.time?.age;
  return typeof age === "number" && age - history.firstAge >= SERVER_ANSWER_TICKS ? FULL_AIR_TICKS : null;
}
