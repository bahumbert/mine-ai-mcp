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
  /** Counts the bodies this tracker has seen: a proof of one body never stands for another. */
  generation: number;
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
  const history: AirHistory = { started: false, wet: false, reported: false, firstAge: null, generation: 0 };
  histories.set(bot, history);
  const startBody = () => void Object.assign(history, { started: true, wet: false, reported: false, firstAge: null, generation: history.generation + 1 });
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
  const reading = readAir(bot, false);
  return reading.kind === "reported" ? reading.ticks : reading.kind === "inferred-full" ? FULL_AIR_TICKS : null;
}

/** What makes air full without a report: this body, this entity and the world age of the read that showed it dry (`readAirSupply`). */
export interface FullAirProof {
  readonly entity: Bot["entity"];
  readonly generation: number;
  readonly age: number;
}

/** One read of the bot's air: `invalid` is a present value that is no integer, or a registry with no `air_supply` key. */
export type AirReading =
  | { readonly kind: "reported"; readonly ticks: number }
  | { readonly kind: "inferred-full"; readonly proof: FullAirProof }
  | { readonly kind: "absent" }
  | { readonly kind: "invalid" };

/**
 * `airSupplyTicks` as a reading that keeps the proof of an inferred full air and tells an unknown air that is merely
 * absent from one that is invalid (the first-air-packet allowance of a dive needs the difference, T31c-air 2026-11-20).
 * A registry with no `air_supply` key is invalid here; `airSupplyTicks` keeps reading it as before.
 */
export function readAirSupply(bot: Bot): AirReading {
  return readAir(bot, true);
}

function readAir(bot: Bot, needKey: boolean): AirReading {
  if (needKey && (bot.registry.entitiesByName.player?.metadataKeys?.indexOf("air_supply") ?? -1) < 0) return { kind: "invalid" };
  const value = ownAirMetadata(bot);
  const history = histories.get(bot);
  if (value !== undefined) {
    if (history) history.reported = true;
    return typeof value === "number" && Number.isInteger(value) ? { kind: "reported", ticks: value } : { kind: "invalid" };
  }
  if (!history) return { kind: "absent" };
  // A read at the call that sees the head under water is an observation like a tick's: the body stays wet.
  if (bot.entity && botEyesInWater(bot)) history.wet = true;
  if (!history.started || history.wet || history.reported || history.firstAge === null) return { kind: "absent" };
  const age = bot.time?.age;
  if (typeof age !== "number" || age - history.firstAge < SERVER_ANSWER_TICKS) return { kind: "absent" };
  return { kind: "inferred-full", proof: { entity: bot.entity, generation: history.generation, age } };
}

/**
 * Whether the body that `proof` described is still that body and has never reported its air since: the same entity, no
 * login or respawn between, and no own metadata filed. A reading made after the head got wet cannot show it (the
 * history latches), so a later wet read asks this of the proof taken while the body was dry.
 */
export function fullAirProofHolds(bot: Bot, proof: FullAirProof): boolean {
  const history = histories.get(bot);
  return history !== undefined && bot.entity === proof.entity && history.generation === proof.generation &&
    history.started && !history.reported && ownAirMetadata(bot) === undefined;
}
