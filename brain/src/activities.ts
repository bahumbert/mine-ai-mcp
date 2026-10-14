import type { SkillName, Step } from "./actions.ts";
import type { ForegroundTool } from "./runtime-client.ts";

/**
 * The kinds of work a character spends its time on (spec 2026-10-03-specialisations-preferences): our vocabulary, like
 * the skill names, not game knowledge. Preferences name them, the time per activity is counted in them, and the
 * opportunities a character sees are tagged with them. Some have no skill yet (trading, pvp, guarding, storing): a
 * persona may still love or hate them, the feeling is in the prompt until the skill exists.
 */
export const ACTIVITIES = [
  "building", "terraforming", "farming", "mining", "woodcutting", "digging", "foraging", "hunting", "mob_combat", "pvp",
  "exploring", "following", "travelling", "crafting", "cooking", "storing", "trading", "guarding",
] as const;
export type Activity = (typeof ACTIVITIES)[number];

/**
 * Getting to where the work is (spec 2026-10-04-activity-time-travel-terraforming): counted and shown like the others,
 * but nobody loves or hates it, so no preference names it.
 */
export const NEUTRAL_ACTIVITIES: ReadonlySet<Activity> = new Set(["travelling"]);

const WORDS: Readonly<Partial<Record<Activity, string>>> = {
  mob_combat: "fighting monsters",
  pvp: "fighting players",
  woodcutting: "cutting wood",
  digging: "digging out a cellar, a pond or a tunnel",
  terraforming: "reshaping ground",
  following: "following someone",
  foraging: "foraging",
  exploring: "exploring",
};

/** How an activity reads in a prompt or the monitor: `fighting monsters` for `mob_combat`. */
export function describeActivity(activity: Activity): string {
  return WORDS[activity] ?? activity;
}

/**
 * The activity a model named: by id (`mob_combat`) or as the prompts word it (`fighting monsters`), in any case.
 * Anything else, "none" included, is no activity.
 */
export function parseActivity(text: string | undefined): Activity | null {
  if (text === undefined) return null;
  const words = text.trim().toLowerCase().replace(/[_\s]+/gu, " ");
  return ACTIVITIES.find((activity) => activity.replaceAll("_", " ") === words || describeActivity(activity).toLowerCase() === words) ?? null;
}

/** Game facts the activity of a step depends on, looked up by the agent through the runtime. */
export interface ActivityFacts {
  /** The game's block tags of the blocks a step gathered, by block name (`view_blocks` kinds). */
  readonly tags: Readonly<Record<string, readonly string[]>>;
  /** Species the game files as hostile (`view_status` mobs). */
  readonly hostile: ReadonlySet<string>;
  /** Item names that are food (`view_status` foods). */
  readonly foods: ReadonlySet<string>;
}

/** One runtime action the body ran for a step, and how long it took. */
export interface ActionTime {
  readonly tool: ForegroundTool;
  readonly input: Readonly<Record<string, unknown>>;
  readonly ms: number;
  /** When it ended (epoch ms): which phase of the step its time belongs to. */
  readonly ended?: number;
}

/**
 * Breaking a block, by the game's own grouping: anything tagged `logs` (every wood, nether stems) is woodcutting,
 * `mineable/pickaxe` mining, `mineable/shovel` digging; the rest (plants, grass, pumpkins, leaves) is foraging.
 */
export function gatheringActivity(block: string, facts: ActivityFacts): Activity {
  const tags = facts.tags[block] ?? [];
  if (tags.includes("logs")) return "woodcutting";
  if (tags.includes("mineable/pickaxe")) return "mining";
  if (tags.includes("mineable/shovel")) return "digging";
  return "foraging";
}

/** Making an item: cooking when it is a food, crafting otherwise. */
function making(item: string, facts: ActivityFacts): Activity {
  return facts.foods.has(item) ? "cooking" : "crafting";
}

/** What one runtime action of a gathering step was; walking is no activity of its own there. */
function actionActivity(action: ActionTime, facts: ActivityFacts): Activity | null {
  const { input } = action;
  switch (action.tool) {
    case "collect_block": return typeof input.block_name === "string" ? gatheringActivity(input.block_name, facts) : null;
    case "craft_item": {
      const items = Array.isArray(input.items) ? input.items as readonly { item_name?: unknown }[] : [];
      return items.some((item) => typeof item.item_name === "string" && facts.foods.has(item.item_name)) ? "cooking" : "crafting";
    }
    case "smelt_item": return typeof input.item_name === "string" ? making(input.item_name, facts) : "crafting";
    case "collect_mob_drop": return typeof input.mob_name === "string" && facts.hostile.has(input.mob_name) ? "mob_combat" : "hunting";
    default: return null;
  }
}

/**
 * The activity of one finished step: by its skill, and for `get_items` by the work it spent most time on (the runtime
 * actions its body ran, `actions`), since fetching a house's materials is mostly chopping or mining. Errands (giving,
 * dropping, eating, protecting an area) are none.
 */
export function activityOf(step: Step, actions: readonly ActionTime[], facts: ActivityFacts): Activity | null {
  switch (step.skill) {
    case "build":
    case "improve_house": return "building";
    case "level_area": return "terraforming";
    case "farm": return "farming";
    case "hunt": return facts.hostile.has(step.mob) ? "mob_combat" : "hunting";
    case "explore": return "exploring";
    case "go_to":
    case "go_to_player": return "travelling";
    case "follow_player": return "following";
    case "collect_block": return gatheringActivity(step.block, facts);
    case "craft_item": return making(step.item, facts);
    case "get_items": {
      const time = new Map<Activity, number>();
      for (const action of actions) {
        const activity = actionActivity(action, facts);
        if (activity !== null) time.set(activity, (time.get(activity) ?? 0) + action.ms);
      }
      const longest = [...time].sort((a, b) => b[1] - a[1])[0];
      if (longest !== undefined) return longest[0];
      return step.items.some(({ item }) => facts.foods.has(item)) ? "cooking" : "crafting";
    }
    case "give_item":
    case "drop_item":
    case "eat":
    case "equip":
    case "sleep":
    case "protect_area":
    case "release_area": return null;
  }
}

/**
 * The kinds of work each skill can do ({@link activityOf} answers one of them): what a character with that skill can
 * take on (spec 2026-10-09-activity-draw, section 2). `hunt` is both: which one depends on the mob. Errands are none.
 */
export const SKILL_ACTIVITIES: Readonly<Record<SkillName, readonly Activity[]>> = {
  build: ["building"],
  improve_house: ["building"],
  level_area: ["terraforming"],
  farm: ["farming"],
  explore: ["exploring"],
  go_to: ["travelling"],
  go_to_player: ["travelling"],
  follow_player: ["following"],
  hunt: ["hunting", "mob_combat"],
  collect_block: ["woodcutting", "mining", "digging", "foraging"],
  craft_item: ["crafting", "cooking"],
  get_items: ["woodcutting", "mining", "digging", "foraging", "crafting", "cooking"],
  give_item: [],
  drop_item: [],
  eat: [],
  equip: [],
  sleep: [],
  protect_area: [],
  release_area: [],
};

/** A part of a step's time spent on one activity. */
export interface ActivitySpan {
  readonly activity: Activity;
  readonly ms: number;
}

/** From this time on (epoch ms), a step's work is this activity: a skill's phase (the house's site preparation). */
export interface ActivityPhase {
  readonly activity: Activity;
  readonly at: number;
}

/** Steps whose whole time is their activity, the walking included: walking is the work there. */
const ALL_OF_IT = new Set<Step["skill"]>(["go_to", "go_to_player", "explore", "follow_player"]);

/**
 * How a finished step's time divides between activities (spec 2026-10-04-activity-time-travel-terraforming): its
 * activity ({@link activityOf}), changed from each phase on; the time its `navigate` actions took counts travelling,
 * taken from the part of the step it fell in. Errands keep only their travelling. Longest first, none empty.
 */
export function activityTimes(step: Step, actions: readonly ActionTime[], facts: ActivityFacts, started: number, ended: number, phases: readonly ActivityPhase[] = []): ActivitySpan[] {
  const main = activityOf(step, actions, facts);
  const total = Math.max(0, ended - started);
  if (ALL_OF_IT.has(step.skill)) return main === null || total === 0 ? [] : [{ activity: main, ms: total }];
  const parts = [{ activity: main, from: started, ms: 0 }, ...[...phases].sort((a, b) => a.at - b.at).map((phase) => ({ activity: phase.activity as Activity | null, from: phase.at, ms: 0 }))];
  parts.forEach((part, index) => {
    part.ms = Math.max(0, (parts[index + 1]?.from ?? ended) - part.from);
  });
  let travelling = 0;
  for (const action of actions) {
    if (action.tool !== "navigate") continue;
    const at = action.ended ?? ended;
    const part = [...parts].reverse().find((candidate) => candidate.from <= at) ?? parts[0]!;
    const taken = Math.min(action.ms, part.ms);
    part.ms -= taken;
    travelling += taken;
  }
  const totals = new Map<Activity, number>();
  if (travelling > 0) totals.set("travelling", travelling);
  for (const part of parts) if (part.activity !== null && part.ms > 0) totals.set(part.activity, (totals.get(part.activity) ?? 0) + part.ms);
  if (totals.size === 0 && main !== null) totals.set(main, 0);
  return [...totals].map(([activity, ms]) => ({ activity, ms })).sort((a, b) => b.ms - a.ms);
}
