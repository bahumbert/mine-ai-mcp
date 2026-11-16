// The agent's stack of objectives (Work) and the two ways a stop ends work on it: everything, or one player's share.
import type { Work } from "./work.ts";

/** "stop": everything on the stack ends, its own goal included. Empties `stack` in place. */
export function stopAll(stack: Work[]): void {
  for (const work of stack) work.step?.abort();
  stack.length = 0;
}

/**
 * "stop" from a player: the orders that player gave and the character's own goals end, the orders of
 * other players stay on the stack (review R18). Removes them from `stack` in place.
 */
export function stopWorkOf(stack: Work[], speaker: string): void {
  const name = speaker.toLowerCase();
  const ends = ({ objective }: Work) => objective.requester === null || objective.requester.toLowerCase() === name;
  for (const work of stack.filter(ends)) work.step?.abort();
  const kept = stack.filter((work) => !ends(work));
  stack.splice(0, stack.length, ...kept);
}
