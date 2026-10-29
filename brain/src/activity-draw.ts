import type { SkillName } from "./actions.ts";
import { ACTIVITIES, SKILL_ACTIVITIES, type Activity } from "./activities.ts";
import type { Persona, Preferences } from "./persona.ts";
import type { BotSnapshot } from "./runtime-client.ts";
import { RECENT_MINUTES } from "./time-spent.ts";

/**
 * The chance of each activity when a character picks its own objective (spec 2026-10-09-activity-draw): tastes are a
 * ratio of time, not "always the loved one". Pure functions; the agent feeds them and the goal tier is only told the
 * result (Rule #0: no code rejects what the model then picks).
 */

/** How strongly each feeling pulls (`persona.settings.feelingMultipliers`). */
export type FeelingMultipliers = Persona["settings"]["feelingMultipliers"];

/**
 * Never drawn: getting there is never a purpose (spec 2026-10-04), following and fighting players need someone and come
 * from requests. The activities no skill does yet (guarding, storing) are out by having no skill.
 */
const NOT_DRAWN: ReadonlySet<Activity> = new Set(["travelling", "following", "pvp"]);

/**
 * The activities a character can take on now: one a skill of its own does ({@link SKILL_ACTIVITIES}), judged from what
 * is in sight where it needs a target (hunting an animal that is not hostile, mob combat a hostile mob, socialising someone
 * to talk with: `partners`, trading someone and something to give). In
 * {@link ACTIVITIES} order.
 */
export function availableActivities(skills: readonly SkillName[], snapshot: BotSnapshot, partners: readonly string[]): Activity[] {
  const can = new Set<Activity>(skills.flatMap((skill) => SKILL_ACTIVITIES[skill]));
  const animals = snapshot.mobs.some((mob) => !mob.hostile);
  const monsters = snapshot.mobs.some((mob) => mob.hostile);
  return ACTIVITIES.filter((activity) => {
    if (!can.has(activity) || NOT_DRAWN.has(activity)) return false;
    if (activity === "hunting") return animals;
    if (activity === "mob_combat") return monsters;
    if (activity === "socialising") return partners.length > 0;
    if (activity === "trading") return partners.length > 0 && hasStackToGive(snapshot);
    return true;
  });
}

/** Something to offer: any carried stack, but a single worn armour piece is not a stack she can give. */
function hasStackToGive(snapshot: BotSnapshot): boolean {
  const worn = new Set((snapshot.gear?.armour ?? []).flatMap((piece) => (piece.item === null ? [] : [piece.item])));
  return snapshot.inventory.some((stack) => stack.count > (worn.has(stack.name) ? 1 : 0));
}

function feelingOf(activity: Activity, preferences: Preferences | undefined): keyof FeelingMultipliers {
  if (preferences === undefined) return "neutral";
  if (preferences.loves === activity) return "loves";
  if (preferences.likes === activity) return "likes";
  if (preferences.dislikes === activity) return "dislikes";
  if (preferences.hates === activity) return "hates";
  return "neutral";
}

export interface ActivityChance {
  readonly activity: Activity;
  readonly chance: number;
}

/**
 * Each available activity's chance: its feeling's multiplier, times what is left of the last hour not yet spent for it
 * (`minutesFor`, in minutes: 15 of 60 leaves 0.75). The 1/n of the spec's formula is the same for all and cancels.
 * When the whole hour went to the available activities, recency is dropped for that draw; when the multipliers are all
 * 0, every activity is equally likely. Most likely first.
 */
export function activityChances(available: readonly Activity[], preferences: Preferences | undefined, multipliers: FeelingMultipliers, minutesFor: (activity: Activity) => number): ActivityChance[] {
  if (available.length === 0) return [];
  const pull = (activity: Activity) => multipliers[feelingOf(activity, preferences)];
  const weigh = (recency: (activity: Activity) => number) => available.map((activity) => ({ activity, weight: pull(activity) * recency(activity) }));
  let weights = weigh((activity) => Math.max(0, 1 - minutesFor(activity) / RECENT_MINUTES));
  if (weights.every(({ weight }) => weight === 0)) weights = weigh(() => 1);
  if (weights.every(({ weight }) => weight === 0)) weights = available.map((activity) => ({ activity, weight: 1 }));
  const total = weights.reduce((sum, { weight }) => sum + weight, 0);
  return weights.map(({ activity, weight }) => ({ activity, chance: weight / total })).sort((a, b) => b.chance - a.chance);
}

/** One activity picked by chance; `random` is a number in [0, 1). */
function pick(chances: readonly ActivityChance[], random: number): ActivityChance {
  const total = chances.reduce((sum, { chance }) => sum + chance, 0);
  let left = random * total;
  for (const entry of chances) {
    if (left < entry.chance) return entry;
    left -= entry.chance;
  }
  return chances.at(-1)!;
}

/**
 * Two different activities drawn by their chances (the second from the rest): what the character is told it feels like
 * doing now, "this, or else that". Fewer when fewer are available. `random` is injected, so tests are deterministic.
 */
export function drawTwo(chances: readonly ActivityChance[], random: () => number): Activity[] {
  if (chances.length === 0) return [];
  const first = pick(chances, random());
  const rest = chances.filter((entry) => entry !== first);
  return rest.length === 0 ? [first.activity] : [first.activity, pick(rest, random()).activity];
}
