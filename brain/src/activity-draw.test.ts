import assert from "node:assert/strict";
import test from "node:test";
import type { Step } from "./actions.ts";
import { SKILL_NAMES } from "./actions.ts";
import { ACTIVITIES, activityOf, SKILL_ACTIVITIES, type Activity, type ActivityFacts } from "./activities.ts";
import { activityChances, availableActivities, drawTwo, type FeelingMultipliers } from "./activity-draw.ts";
import type { Preferences } from "./persona.ts";
import type { BotSnapshot, NearbyMob } from "./runtime-client.ts";

const MULTIPLIERS: FeelingMultipliers = { loves: 2, likes: 1.5, neutral: 1, dislikes: 0.6, hates: 0.3 };

const snapshot = (mobs: readonly NearbyMob[] = []): BotSnapshot => ({
  position: { x: 0, y: 64, z: 0 }, dimension: "minecraft:overworld", health: 20, food: 20, inventory: [], foods: [], mobs, players: [], policy: null,
});
const cow: NearbyMob = { name: "cow", hostile: false, count: 2, distance: 8 };
const zombie: NearbyMob = { name: "zombie", hostile: true, count: 1, distance: 12 };

/** Ten activities as in the spec's example: 1 loved, 1 liked, 6 neutral, 1 disliked, 1 hated. */
const TEN: readonly Activity[] = ["building", "farming", "mining", "woodcutting", "digging", "foraging", "exploring", "crafting", "cooking", "terraforming"];
const PREFERENCES: Preferences = { loves: "building", likes: "farming", dislikes: "mining", hates: "woodcutting" };

const share = (chances: readonly { activity: Activity; chance: number }[], activity: Activity) => chances.find((entry) => entry.activity === activity)!.chance;
const noTime = () => 0;

/** A small deterministic random source (mulberry32), so a draw is the same for a seed. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("with every skill and nothing in sight, the kinds of work a skill does are available; errands, targets and unbuilt skills are not", () => {
  const available = availableActivities(SKILL_NAMES, snapshot());
  assert.deepEqual(new Set(available), new Set(["building", "terraforming", "farming", "crafting", "cooking", "woodcutting", "mining", "digging", "foraging", "exploring"]));
  for (const never of ["travelling", "following", "pvp", "trading", "guarding", "storing", "hunting", "mob_combat"] as const) assert.ok(!available.includes(never), never);
});

test("hunting needs an animal in sight and mob combat a hostile mob, both with the hunt skill", () => {
  assert.ok(availableActivities(SKILL_NAMES, snapshot([cow])).includes("hunting"));
  assert.ok(!availableActivities(SKILL_NAMES, snapshot([cow])).includes("mob_combat"));
  assert.ok(availableActivities(SKILL_NAMES, snapshot([zombie])).includes("mob_combat"));
  assert.ok(!availableActivities(SKILL_NAMES, snapshot([zombie])).includes("hunting"));
  assert.deepEqual(availableActivities(SKILL_NAMES, snapshot([cow, zombie])).filter((activity) => activity === "hunting" || activity === "mob_combat"), ["hunting", "mob_combat"]);
  const withoutHunt = SKILL_NAMES.filter((skill) => skill !== "hunt");
  assert.deepEqual(availableActivities(withoutHunt, snapshot([cow, zombie])).filter((activity) => activity === "hunting" || activity === "mob_combat"), []);
});

test("a persona's skills decide: build alone is building, collect_block the four gatherings, craft_item crafting and cooking, get_items all of those", () => {
  assert.deepEqual(availableActivities(["build"], snapshot()), ["building"]);
  assert.deepEqual(new Set(availableActivities(["collect_block"], snapshot())), new Set(["woodcutting", "mining", "digging", "foraging"]));
  assert.deepEqual(new Set(availableActivities(["craft_item"], snapshot())), new Set(["crafting", "cooking"]));
  assert.deepEqual(new Set(availableActivities(["get_items"], snapshot())), new Set(["woodcutting", "mining", "digging", "foraging", "crafting", "cooking"]));
  assert.deepEqual(availableActivities(["go_to", "follow_player", "give_item"], snapshot()), []);
});

test("SKILL_ACTIVITIES covers every skill and every activityOf answer is one the skill is listed for", () => {
  assert.deepEqual(Object.keys(SKILL_ACTIVITIES).sort(), [...SKILL_NAMES].sort());
  for (const activities of Object.values(SKILL_ACTIVITIES)) for (const activity of activities) assert.ok(ACTIVITIES.includes(activity));
  const facts: ActivityFacts = { tags: { oak_log: ["logs"], stone: ["mineable/pickaxe"], dirt: ["mineable/shovel"], short_grass: [] }, hostile: new Set(["zombie"]), foods: new Set(["bread"]) };
  const steps: Step[] = [
    { skill: "build", structure: "house", size: "small" },
    { skill: "level_area", radius: 5 },
    { skill: "farm", size: 9 },
    { skill: "explore", toward: "north", chunks: 4 },
    { skill: "go_to", x: 1, y: 64, z: 1 },
    { skill: "follow_player", player: "Tom", distance: 3 },
    { skill: "hunt", mob: "cow", drop: "beef", count: 1 },
    { skill: "hunt", mob: "zombie", drop: "rotten_flesh", count: 1 },
    { skill: "collect_block", block: "oak_log", count: 1 },
    { skill: "collect_block", block: "stone", count: 1 },
    { skill: "collect_block", block: "dirt", count: 1 },
    { skill: "collect_block", block: "short_grass", count: 1 },
    { skill: "craft_item", item: "bread", count: 1 },
    { skill: "craft_item", item: "stick", count: 1 },
    { skill: "get_items", items: [{ item: "bread", count: 1 }] },
    { skill: "get_items", items: [{ item: "stick", count: 1 }] },
  ];
  for (const step of steps) {
    const activity = activityOf(step, [], facts);
    assert.ok(activity === null || SKILL_ACTIVITIES[step.skill].includes(activity), `${step.skill} → ${activity}`);
  }
});

test("chances follow the multipliers: a neutral activity always weighs more than a disliked or hated one, whatever the number", () => {
  const chances = activityChances(TEN, PREFERENCES, MULTIPLIERS, noTime);
  assert.ok(Math.abs(chances.reduce((sum, entry) => sum + entry.chance, 0) - 1) < 1e-9);
  const [loves, likes, neutral, dislikes, hates] = (["building", "farming", "digging", "mining", "woodcutting"] as const).map((activity) => share(chances, activity)) as [number, number, number, number, number];
  assert.ok(loves > likes && likes > neutral && neutral > dislikes && dislikes > hates);
  // 2 + 1.5 + 6 × 1 + 0.6 + 0.3 = 10.4 weights
  assert.ok(Math.abs(loves - 2 / 10.4) < 1e-9);
  assert.ok(Math.abs(neutral - 1 / 10.4) < 1e-9);
  assert.ok(Math.abs(hates - 0.3 / 10.4) < 1e-9);
  // Sorted, most likely first.
  assert.deepEqual(chances.map((entry) => entry.chance), [...chances.map((entry) => entry.chance)].sort((a, b) => b - a));
  assert.equal(chances[0]!.activity, "building");
  assert.equal(chances.at(-1)!.activity, "woodcutting");
  // Even with every activity in the list a neutral one beats a hated one.
  const many = ACTIVITIES.filter((activity) => activity !== "travelling");
  const wide = activityChances(many, { loves: many[0]!, likes: many[1]!, dislikes: many[2]!, hates: many[3]! }, MULTIPLIERS, noTime);
  assert.ok(share(wide, many[4]!) > share(wide, many[2]!) && share(wide, many[2]!) > share(wide, many[3]!));
});

test("15 minutes of the last hour spent for an activity leaves it 0.75 of its chance; 60 minutes leaves none", () => {
  const two: readonly Activity[] = ["mining", "building"];
  const none = activityChances(two, undefined, MULTIPLIERS, noTime);
  assert.ok(Math.abs(share(none, "mining") - 0.5) < 1e-9);
  const tired = activityChances(two, undefined, MULTIPLIERS, (activity) => activity === "mining" ? 15 : 0);
  assert.ok(Math.abs(share(tired, "mining") - 0.75 / 1.75) < 1e-9);
  assert.ok(Math.abs(share(tired, "building") - 1 / 1.75) < 1e-9);
  const spent = activityChances(two, undefined, MULTIPLIERS, (activity) => activity === "mining" ? 75 : 0);
  assert.equal(share(spent, "mining"), 0, "more than an hour is not a negative weight");
  assert.equal(share(spent, "building"), 1);
});

test("when the whole hour went to the available activities, recency is dropped for that draw: the tastes alone decide", () => {
  const all = activityChances(["mining", "building"], { loves: "building", likes: "farming", dislikes: "digging", hates: "mining" }, MULTIPLIERS, () => 60);
  assert.ok(Math.abs(share(all, "building") - 2 / 2.3) < 1e-9);
  assert.ok(Math.abs(share(all, "mining") - 0.3 / 2.3) < 1e-9);
  const only = activityChances(["exploring"], undefined, MULTIPLIERS, () => 60);
  assert.deepEqual(only, [{ activity: "exploring", chance: 1 }]);
});

test("a persona with no preferences feels the same about everything, and multipliers of 0 everywhere never make a NaN", () => {
  const chances = activityChances(TEN, undefined, MULTIPLIERS, noTime);
  for (const entry of chances) assert.ok(Math.abs(entry.chance - 0.1) < 1e-9);
  const zero = activityChances(["mining", "building"], { loves: "building", likes: "farming", dislikes: "digging", hates: "mining" }, { loves: 0, likes: 0, neutral: 0, dislikes: 0, hates: 0 }, noTime);
  assert.deepEqual(zero.map((entry) => entry.chance), [0.5, 0.5]);
  assert.deepEqual(activityChances([], undefined, MULTIPLIERS, noTime), []);
});

test("only the activities given are drawn from", () => {
  const chances = activityChances(["mining", "exploring"], PREFERENCES, MULTIPLIERS, noTime);
  assert.deepEqual(chances.map((entry) => entry.activity).sort(), ["exploring", "mining"]);
});

test("drawTwo picks by the chances, then another from the rest; fewer available means fewer drawn", () => {
  const chances = activityChances(["building", "mining", "exploring"], { loves: "building", likes: "farming", dislikes: "mining", hates: "woodcutting" }, MULTIPLIERS, noTime);
  // 2 : 1 : 0.6 → building 0.556, exploring 0.278, mining 0.167 (sorted).
  assert.deepEqual(chances.map((entry) => entry.activity), ["building", "exploring", "mining"]);
  assert.deepEqual(drawTwo(chances, () => 0), ["building", "exploring"]);
  assert.deepEqual(drawTwo(chances, () => 0.999), ["mining", "exploring"]);
  // First 0.6 falls in exploring's slice (0.556 to 0.833); the rest is building 2/2.6 and mining 0.6/2.6 → 0.1 is building.
  const values = [0.6, 0.1];
  assert.deepEqual(drawTwo(chances, () => values.shift()!), ["exploring", "building"]);
  assert.deepEqual(drawTwo([{ activity: "mining", chance: 1 }], () => 0.3), ["mining"]);
  assert.deepEqual(drawTwo([], () => 0.3), []);
});

test("a seeded draw is the same each time, and always two different activities", () => {
  const chances = activityChances(TEN, PREFERENCES, MULTIPLIERS, noTime);
  const first = Array.from({ length: 50 }, ((random) => () => drawTwo(chances, random))(seeded(7)));
  const again = Array.from({ length: 50 }, ((random) => () => drawTwo(chances, random))(seeded(7)));
  assert.deepEqual(first, again);
  for (const drawn of first) {
    assert.equal(drawn.length, 2);
    assert.notEqual(drawn[0], drawn[1]);
  }
  assert.notDeepEqual(first, Array.from({ length: 50 }, ((random) => () => drawTwo(chances, random))(seeded(8))));
});

test("1000 draws with the hour's time fed back land near the spec's shares: loves ~18, each neutral ~10, hates ~3", () => {
  const random = seeded(2026);
  const STEP_MINUTES = 5;
  const picks: Activity[] = [];
  const counts = new Map<Activity, number>();
  for (let draw = 0; draw < 1000; draw += 1) {
    // The last hour of play: the latest 12 steps of 5 minutes.
    const hour = picks.slice(-60 / STEP_MINUTES);
    const chances = activityChances(TEN, PREFERENCES, MULTIPLIERS, (activity) => hour.filter((done) => done === activity).length * STEP_MINUTES);
    const [followed] = drawTwo(chances, random);
    picks.push(followed!);
    counts.set(followed!, (counts.get(followed!) ?? 0) + 1);
  }
  const percent = (activity: Activity) => (counts.get(activity) ?? 0) / 10;
  assert.ok(Math.abs(percent("building") - 18) <= 4, `loves ${percent("building")}`);
  assert.ok(Math.abs(percent("farming") - 14) <= 4, `likes ${percent("farming")}`);
  for (const neutral of ["digging", "foraging", "exploring", "crafting", "cooking", "terraforming"] as const) assert.ok(Math.abs(percent(neutral) - 10) <= 4, `${neutral} ${percent(neutral)}`);
  assert.ok(Math.abs(percent("mining") - 6) <= 4, `dislikes ${percent("mining")}`);
  assert.ok(Math.abs(percent("woodcutting") - 3) <= 4 && percent("woodcutting") > 0, `hates ${percent("woodcutting")}`);
});
