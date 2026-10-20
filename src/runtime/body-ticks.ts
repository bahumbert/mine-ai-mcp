// Body ticks: one tick per physics tick, paced on the wall clock while the bot is seated (no physics in a boat).
import type { Bot } from "mineflayer";
import { currentVehicle } from "../actions/navigate/vehicle-sync.js";

/**
 * Mineflayer switches physics off at a mount, so a bot in a boat gets no `physicsTick`: code that only senses (the
 * hunger and hostile reflexes) would go deaf for the whole ride. `onBodyTick` gives such code one tick per physics
 * tick, and while the bot is seated one per wall-clock `SEATED_TICK_MS` instead.
 */

/** One body tick: a physics tick, or (seated) a wall-clock pace tick. */
export interface BodyTick {
  readonly seated: boolean;
}

/** The pace of a seated bot: one server tick, on the wall clock because the physics clock is stopped. */
export const SEATED_TICK_MS = 50;

type BodyTickListener = (tick: BodyTick) => void;

/** The one pacer of a bot: its listeners, and the interval that runs only while she is seated. */
interface Pacer {
  readonly listeners: Set<BodyTickListener>;
  interval: ReturnType<typeof setInterval> | null;
  /** A physics tick came in this slot, so the pace tick of the slot is skipped (never two ticks per slot). */
  slotFed: boolean;
  /** Stops the pace and takes the pacer's listeners off the bot. */
  release: () => void;
}

const pacers = new WeakMap<Bot, Pacer>();

/** Deliver one tick to every listener, even when one throws; the first error is rethrown after the last listener ran. */
function deliver(pacer: Pacer, tick: BodyTick): void {
  let failure: { readonly error: unknown } | null = null;
  for (const listener of [...pacer.listeners]) {
    if (!pacer.listeners.has(listener)) continue;
    try {
      listener(tick);
    } catch (error) {
      failure ??= { error };
    }
  }
  if (failure !== null) throw failure.error;
}

function stopPace(pacer: Pacer): void {
  if (pacer.interval === null) return;
  clearInterval(pacer.interval);
  pacer.interval = null;
}

/** Start the seated pace unless it runs already; every pace tick re-checks the seat, so a forgotten vehicle ends it. */
function startPace(bot: Bot, pacer: Pacer): void {
  if (pacer.interval !== null) return;
  pacer.slotFed = false;
  pacer.interval = setInterval(() => {
    if (currentVehicle(bot) === null) return stopPace(pacer);
    if (pacer.slotFed) {
      pacer.slotFed = false;
      return;
    }
    deliver(pacer, { seated: true });
  }, SEATED_TICK_MS);
}

function createPacer(bot: Bot): Pacer {
  const pacer: Pacer = { listeners: new Set(), interval: null, slotFed: false, release: () => undefined };
  const onPhysicsTick = () => {
    const seated = currentVehicle(bot) !== null;
    if (seated) pacer.slotFed = true;
    deliver(pacer, { seated });
  };
  const onMount = () => startPace(bot, pacer);
  const onStop = () => stopPace(pacer);
  const onEnd = () => {
    release();
    pacer.listeners.clear();
  };
  const release = () => {
    stopPace(pacer);
    bot.off("physicsTick", onPhysicsTick);
    bot.off("mount", onMount);
    bot.off("dismount", onStop);
    bot.off("death", onStop);
    bot.off("end", onEnd);
    pacers.delete(bot);
  };
  bot.on("physicsTick", onPhysicsTick);
  bot.on("mount", onMount);
  bot.on("dismount", onStop);
  bot.on("death", onStop);
  bot.on("end", onEnd);
  pacer.release = release;
  return pacer;
}

/**
 * Run `listener` on every body tick of `bot`; returns the unsubscribe. All listeners of a bot share one pacer, which
 * stops at dismount, death, end and when the last listener is removed.
 */
export function onBodyTick(bot: Bot, listener: BodyTickListener): () => void {
  let pacer = pacers.get(bot);
  if (pacer === undefined) {
    pacer = createPacer(bot);
    pacers.set(bot, pacer);
  }
  pacer.listeners.add(listener);
  if (currentVehicle(bot) !== null) startPace(bot, pacer);
  const owner = pacer;
  return () => {
    if (!owner.listeners.delete(listener) || owner.listeners.size > 0) return;
    owner.release();
  };
}
