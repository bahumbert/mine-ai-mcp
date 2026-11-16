// The agent's stack of objectives (Work) and the two ways a stop ends work on it: everything, or one player's share.
import type { SituationKind } from "./situations.ts";
import { newWork, type SituationState, type StepDecision, type Work } from "./work.ts";

/** The top ordinary objective, ignoring situation events. */
export function topWork(stack: readonly Work[]): Work | undefined {
  return stack.findLast((work) => work.situation === null);
}

/** The ordinary work beneath this event, or the bottom event when there is none. */
export function neededWork(stack: readonly Work[], work: Work): Work {
  const below = stack.slice(0, stack.indexOf(work) + 1);
  return topWork(below) ?? below[0] ?? work;
}

/** Add a decided situation without interrupting the running work. */
export function pushSituation(stack: Work[], state: SituationState, text: string, planned: StepDecision): Work {
  const work = newWork({ text, requester: null, purpose: null }, null, state, planned);
  stack.push(work);
  return work;
}

/** The most recent situation of a given kind. */
export function situationOf(stack: readonly Work[], kind: SituationKind): Work | undefined {
  return stack.findLast((work) => work.situation?.info.kind === kind);
}

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
