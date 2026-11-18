// Server-confirmed productive evidence for the scenario still watchdog.
import type { Bot } from "mineflayer";
import { monotonicNow } from "../../../src/utils/monotonic-clock.ts";
import { AGE_PACKET_TICKS } from "../../../src/world/world-age.ts";
import { DRIVER_CLOCK_STOPPED_MS } from "./server-ticks.ts";

export interface ProductiveProgress extends Disposable {
  /** Repeated samples of the same phase preserve its age; false ends this request's window. */
  observing(active: boolean): void;
}

/** Own one runtime observation window, counted only by server time packets. */
function observationWindow(bot: Bot, progress: (reason: string) => void): ProductiveProgress {
  let active = false;
  let age: number | null = null;
  let declaredAge: number | null = null;
  let lastMoveAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    active = false;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    bot.off("time", onTime);
  };
  const renew = () => {
    if (timer !== undefined) clearTimeout(timer);
    lastMoveAt = monotonicNow();
    timer = setTimeout(stop, DRIVER_CLOCK_STOPPED_MS);
  };
  const onTime = () => {
    // wall bound: expire a stopped world-age clock even if its timer callback was delayed.
    if (monotonicNow() - lastMoveAt >= DRIVER_CLOCK_STOPPED_MS) return stop();
    const nextAge = bot.time.age;
    if (nextAge === null || nextAge === age) return;
    if (age === null || nextAge < age) declaredAge = nextAge;
    age = nextAge;
    renew();
    if (declaredAge !== null && age - declaredAge >= AGE_PACKET_TICKS) {
      declaredAge = age;
      progress("observing");
    }
  };
  return {
    observing(value) {
      if (!value) return stop();
      if (active) return;
      active = true;
      age = declaredAge = bot.time.age;
      renew();
      bot.on("time", onTime);
    },
    [Symbol.dispose]: stop,
  };
}

/** Declare only server-confirmed productive evidence while this driver owns the observer. */
export function declareProductiveProgress(bot: Bot, progress: (reason: string) => void, signal?: AbortSignal): ProductiveProgress {
  const window = observationWindow(bot, progress);
  let closed = false;
  let health = bot.health;
  const onDamage = (packet: { entityId: number; sourceCauseId: number }) => {
    if (packet.sourceCauseId - 1 === bot.entity.id && packet.entityId !== bot.entity.id) progress("hit");
  };
  const onHealth = () => {
    const healed = bot.health > health;
    health = bot.health;
    if (healed) progress("healed");
  };
  const dispose = () => {
    if (closed) return;
    closed = true;
    window[Symbol.dispose]();
    bot._client.off("damage_event", onDamage);
    bot.off("health", onHealth);
    bot.off("death", dispose);
    bot.off("end", dispose);
    signal?.removeEventListener("abort", dispose);
  };
  if (signal?.aborted || bot.health <= 0) closed = true;
  else {
    bot._client.on("damage_event", onDamage);
    bot.on("health", onHealth);
    bot.on("death", dispose);
    bot.on("end", dispose);
    signal?.addEventListener("abort", dispose, { once: true });
  }
  return {
    observing(active) { if (!closed) window.observing(active); },
    [Symbol.dispose]: dispose,
  };
}
