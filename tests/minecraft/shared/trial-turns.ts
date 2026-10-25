// How the scheduler reads its queue of trials: whose turn each trial takes, and how many trials of each pool key could start.
import type { QueuedTrial, Submission } from "./scheduler-records.ts";

/** The queue interleaved by submission, each taking a turn, the first turn going to the submission after the last one served. */
export function turnOrder(queue: readonly QueuedTrial[], lastServed: number): QueuedTrial[] {
  const bySubmission = new Map<number, QueuedTrial[]>();
  for (const queued of queue) {
    const own = bySubmission.get(queued.submission.id) ?? [];
    own.push(queued);
    bySubmission.set(queued.submission.id, own);
  }
  const ids = [...bySubmission.keys()].sort((first, second) => first - second);
  const next = ids.findIndex(id => id > lastServed);
  const turn = next < 0 ? ids : [...ids.slice(next), ...ids.slice(0, next)];
  const order: QueuedTrial[] = [];
  for (let round = 0; order.length < queue.length; round++) {
    for (const id of turn) {
      const queued = bySubmission.get(id)![round];
      if (queued) order.push(queued);
    }
  }
  return order;
}

/** Queued trials per pool key, each submission's `--lanes N` cap taken off: the trials past it cannot start, so they are no demand for a server. */
export function countStartableTrialsPerKey(queue: readonly QueuedTrial[]): Map<string, number> {
  const counts = new Map<string, number>();
  const room = new Map<Submission, number>();
  for (const queued of queue) {
    const { submission } = queued;
    const cap = submission.spec.maxLanes;
    const left = room.get(submission) ?? (cap === null ? Infinity : Math.max(0, cap - submission.running));
    if (left <= 0) continue;
    room.set(submission, left - 1);
    const key = queued.entry.placement.key;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}
