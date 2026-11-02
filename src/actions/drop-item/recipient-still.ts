// A hand-over is thrown at a recipient who stands still within reach: a tossed item can be taken only after its 40-tick
// pickup delay, so a recipient who is walking is elsewhere when it can be picked up (facts/relations.md "Hand-over hold").
import type { Bot } from "mineflayer";
import type { Vec3 } from "vec3";

/** World-age ticks the recipient must stay still for. The age moves in jumps of 20 with the server's time packets, so a stalled server never moves it. */
export const RECIPIENT_STILL_TICKS = 10;
/** The most (blocks, 3-D) the recipient may be from the window's first sample and still count as still: an idle player's position packets jitter. */
export const RECIPIENT_STILL_EPSILON = 0.1;
/** The wall-clock bound of the whole approach and wait. */
export const RECIPIENT_WAIT_MS = 10_000;

export interface StillWait {
  /** Beyond this 3-D distance from the bot the recipient is `away`. */
  readonly range: number;
  readonly stillTicks: number;
  readonly epsilon: number;
  readonly maxWallMs: number;
  readonly signal?: AbortSignal;
}

/** `still`: moved no more than `epsilon` over `stillTicks` of world age; `away`: beyond `range`; `left`: not observed; `timeout`: the wall bound. */
export type StillOutcome = "still" | "away" | "left" | "timeout";

/**
 * Wait, one client tick at a time, for the named player to stand still within `range`. A sample beyond `epsilon` of the
 * window's first one starts a new window there, so a slow drift never adds up to stillness. The world age moves in jumps of 20,
 * so a window must also span `stillTicks` client ticks: one begun just before a time packet is not ten ticks of stillness. The wall-clock timer, not the
 * ticks, ends a wait on a client whose ticks stopped or a server whose age does not move.
 */
export function awaitStillRecipient(bot: Bot, name: string, wait: StillWait): Promise<StillOutcome> {
  const { signal } = wait;
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise<StillOutcome>((resolve, reject) => {
    let window: { readonly position: Vec3; readonly age: number; ticks: number } | null = null;
    const finish = (settle: () => void) => {
      clearTimeout(timer);
      bot.off("physicsTick", onTick);
      signal?.removeEventListener("abort", onAbort);
      settle();
    };
    const onAbort = () => finish(() => reject(signal?.reason));
    const timer = setTimeout(() => finish(() => resolve("timeout")), wait.maxWallMs);
    const onTick = () => {
      const entity = bot.players[name]?.entity;
      if (!entity) return finish(() => resolve("left"));
      if (bot.entity.position.distanceTo(entity.position) > wait.range) return finish(() => resolve("away"));
      const age = bot.time.age;
      if (age === null || age === undefined) return; // no time packet yet: nothing counts as time passed
      if (window === null || window.position.distanceTo(entity.position) > wait.epsilon) {
        window = { position: entity.position.clone(), age, ticks: 0 };
      } else if (++window.ticks >= wait.stillTicks && age - window.age >= wait.stillTicks) {
        finish(() => resolve("still"));
      }
    };
    bot.on("physicsTick", onTick);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
