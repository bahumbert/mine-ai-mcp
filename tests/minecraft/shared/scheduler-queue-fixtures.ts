// The lane trials and queue counts the scheduler queue tests build their cases from.
import { lanePlacement, SchedulerRig } from "./scheduler-rig.ts";

/** `count` lane trials of the pool key `key`. */
export const lanes = (count: number, key = "k") => Array.from({ length: count }, (_, index) => ({ name: `t${index}`, placement: lanePlacement(key) }));
/** How many arrangements wait in each server's mutex queue. */
export const queued = (rig: SchedulerRig) => Object.fromEntries([...rig.pool.queues(rig.pool.list().map(server => server.id))].map(([id, queue]) => [id, queue.queued]));
