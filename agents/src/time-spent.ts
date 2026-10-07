import { describeActivity, type Activity } from "./activities.ts";

/** One finished step's work: its activity, when it ended, how long it took. */
export interface ActivityTime {
  readonly activity: Activity;
  /** ISO time the step ended. */
  readonly ended: string;
  readonly minutes: number;
}

export interface ActivityTotal {
  readonly activity: Activity;
  readonly minutes: number;
}

/**
 * The window the goal tier sees: what it did in its last hour of play, so older work drops out as it plays on. Play,
 * not the clock (spec 2026-10-04-activity-time-travel-terraforming): a restart carries on from where it left off.
 */
export const RECENT_MINUTES = 60;

/**
 * The records of the last `minutes` of play, oldest first: summed back from the newest; the oldest one kept is cut to
 * its part inside. Time between steps and offline is not play.
 */
export function lastOfPlay(records: readonly ActivityTime[], minutes = RECENT_MINUTES): ActivityTime[] {
  const kept: ActivityTime[] = [];
  let left = minutes;
  for (let index = records.length - 1; index >= 0 && left > 0; index -= 1) {
    const record = records[index]!;
    const part = Math.min(record.minutes, left);
    kept.unshift(part === record.minutes ? record : { ...record, minutes: part });
    left -= part;
  }
  return kept;
}

/**
 * Minutes per activity spent after `since` (epoch ms), most first: a step that started before `since` counts only its
 * part after it. Steps with no activity were never recorded.
 */
export function minutesByActivity(records: readonly ActivityTime[], since = Number.NEGATIVE_INFINITY): ActivityTotal[] {
  const totals = new Map<Activity, number>();
  for (const record of records) {
    const ended = Date.parse(record.ended);
    if (!Number.isFinite(ended) || ended <= since) continue;
    const minutes = Math.min(record.minutes, (ended - since) / 60_000);
    totals.set(record.activity, (totals.get(record.activity) ?? 0) + minutes);
  }
  return [...totals].map(([activity, minutes]) => ({ activity, minutes })).sort((a, b) => b.minutes - a.minutes);
}

/** `farming 25 min, building 10 min, exploring under a minute`; `nothing yet` when empty. */
export function describeTime(totals: readonly ActivityTotal[]): string {
  if (totals.length === 0) return "nothing yet";
  return totals.map(({ activity, minutes }) => `${describeActivity(activity)} ${minutes < 1 ? "under a minute" : `${Math.round(minutes)} min`}`).join(", ");
}
