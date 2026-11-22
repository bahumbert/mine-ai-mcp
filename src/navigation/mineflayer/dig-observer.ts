/**
 * What navigation's break effect reports to whoever watches the digs of a route: which block, with which tool (null: by
 * hand) and for how long. One listener set per bot, so a navigate call counts the digs of its own route and closes its
 * listener when it settles; a listener that throws never fails the break (the dig already happened).
 */
import type { Bot } from "mineflayer";

export interface NavigationDig {
  /** The registry name of the block that was dug. */
  readonly block: string;
  /** The item type the route dug with; null when it dug by hand. */
  readonly toolType: number | null;
  /** From the dig's start to the end of its effect, in monotonic milliseconds. */
  readonly ms: number;
}

const listeners = new WeakMap<Bot, Set<(dig: NavigationDig) => void>>();

/** Calls `onDig` for each dig reported on `bot` until the returned function is called (twice is harmless). */
export function observeNavigationDigs(bot: Bot, onDig: (dig: NavigationDig) => void): () => void {
  const own = listeners.get(bot) ?? new Set();
  listeners.set(bot, own);
  // A wrapper per call, so observing the same function twice gives two independent subscriptions.
  const subscription = (dig: NavigationDig) => onDig(dig);
  own.add(subscription);
  return () => {
    own.delete(subscription);
  };
}

/** Tells every open listener of `bot` about one finished dig. */
export function reportNavigationDig(bot: Bot, dig: NavigationDig): void {
  for (const listener of [...(listeners.get(bot) ?? [])]) {
    try {
      listener(dig);
    } catch {
      // An observer's bug must not turn a dug block into a failed break.
    }
  }
}
