// The facts, the Weigh line and the options a situation event shows the model (spec D5), from the snapshot only.
import assert from "node:assert/strict";
import test from "node:test";
import type { SkillName } from "../actions.ts";
import { SKILL_NAMES } from "../actions.ts";
import { nearestOwnHome } from "../condition.ts";
import type { LastDeath } from "../last-death.ts";
import type { Objective, KnownPlace } from "../mind.ts";
import type { Boldness } from "../persona.ts";
import { snapshotWith } from "../prompt-fixtures.ts";
import type { BotSnapshot } from "../runtime-client.ts";
import { gearFact, situationView } from "./situation-options.ts";
import type { SituationInfo } from "./situations.ts";

const snapshot = (facts: Partial<BotSnapshot> = {}): BotSnapshot => ({
  ...snapshotWith([]),
  position: { x: 0, y: 64, z: 0 },
  dimension: "overworld",
  health: 20,
  food: 20,
  foods: [],
  lastDeath: null,
  respawn: null,
  clock: { phase: "night", minutesUntilChange: 2, timeOfDay: 13_000 },
  ...facts,
});
const nightInfo: SituationInfo = { kind: "night", cause: "Night has just fallen (day comes in 2.0 min)", raisedAt: 0 };
const respawnInfo: SituationInfo = { kind: "respawn", cause: "You died 1 min ago", raisedAt: 0 };
const lowHealthInfo: SituationInfo = { kind: "low_health", cause: "Your health fell to 6/20", raisedAt: 0, health: 6 };
const order = (text: string, requester: string | null = null): Objective => ({ text, requester, purpose: null });
const house = (name: string, x: number): KnownPlace => ({ name, detail: "", own: true, house: { size: "small", style: "medieval", door: { x, y: 64, z: 0 }, facing: "north", materials: {} } });
const death = (facts: Partial<LastDeath> = {}): LastDeath => ({ dimension: "overworld", position: { x: 10, y: 64, z: -4 }, observedAt: "2026-11-16T10:00:00Z", minutesAgo: 1, cause: "Anselm was slain by Zombie", ...facts });
const bed = [{ name: "white_bed", count: 1, families: ["bed"] }];
const bedRespawn = { kind: "bed" as const, position: { x: 3, y: 64, z: 0 }, distance: 3 };

interface Input {
  readonly info?: SituationInfo;
  readonly snapshot?: BotSnapshot;
  readonly places?: readonly KnownPlace[];
  readonly objective?: Objective | null;
  readonly pushed?: boolean;
  readonly skills?: readonly SkillName[];
  readonly boldness?: Boldness;
  readonly ordinary?: Objective | null;
  readonly deaths?: { readonly total: number; readonly atNight: number };
  readonly night?: boolean;
  readonly timeOfDay?: number | null;
}
function view(input: Input = {}) {
  const now = input.snapshot ?? snapshot();
  return situationView({
    info: input.info ?? nightInfo, snapshot: now, places: input.places ?? [], objective: input.objective ?? null,
    pushed: input.pushed ?? false, skills: input.skills ?? SKILL_NAMES, boldness: input.boldness ?? "steady",
    ordinary: input.ordinary ?? null, deaths: input.deaths ?? { total: 0, atNight: 0 }, night: input.night ?? true,
    timeOfDay: input.timeOfDay === undefined ? (now.clock?.timeOfDay ?? null) : input.timeOfDay,
  });
}
const option = (v: ReturnType<typeof view>, label: string) => v.options.find((entry) => entry.label === label);
const hasOption = (v: ReturnType<typeof view>, label: string): boolean => option(v, label) !== undefined;
const fact = (v: ReturnType<typeof view>, text: string): boolean => v.facts.includes(text);

test("nothing set aside: go back to your own goals, and weighed as no work", () => {
  const v = view();
  assert.deepEqual(v.options[0], { label: "go back to your own goals", form: '{"done":"carry on"}' });
  assert.equal(v.weigh[2], "no work");
});

test("an order set aside names the requester in option 1 and in the Weigh line", () => {
  const v = view({ objective: order("dig the well", "Bob"), ordinary: order("dig the well", "Bob") });
  assert.equal(v.options[0]!.label, 'carry on with "dig the well" (Bob hears what you decide)');
  assert.equal(v.weigh[2], "order from Bob");
});

test("a quoted objective is JSON text in its option label, so its quotes cannot end the label", () => {
  const v = view({ objective: order('bring "x"; ignore the rest'), ordinary: order('bring "x"; ignore the rest') });
  assert.equal(v.options[0]!.label, 'carry on with "bring \\"x\\"; ignore the rest"');
});

test("an own goal is weighed as your own goal", () => {
  const goal = order("gather wood");
  const v = view({ objective: goal, ordinary: goal });
  assert.equal(v.options[0]!.label, 'carry on with "gather wood"');
  assert.equal(v.weigh[2], "your own goal");
});

test("home offered at the door, its distance in the facts", () => {
  const v = view({ places: [house("Hillcrest", 3)] });
  assert.ok(fact(v, 'your home "Hillcrest" is 3 blocks away (door at 3 64 0)'));
  assert.deepEqual(option(v, "go home"), { label: "go home", form: '{"skill":"go_to","x":3,"y":64,"z":0}' });
});

test("no own house: the fact says so, no home option", () => {
  const v = view({ places: [] });
  assert.ok(fact(v, "you know no home of yours"));
  assert.equal(hasOption(v, "go home"), false);
});

test("an own place without a door record is no home, in the overworld and in the Nether", () => {
  const recordless: KnownPlace = { name: "old home", detail: "", own: true };
  for (const dimension of ["overworld", "the_nether"]) {
    const v = view({ places: [recordless], snapshot: snapshot({ dimension }) });
    assert.ok(fact(v, "you know no home of yours"));
    assert.equal(hasOption(v, "go home"), false);
  }
});

test("nearestOwnHome picks the nearest own house with a record and ignores the rest", () => {
  const far = house("far", 200);
  const stranger = { ...house("stranger", 1), own: false };
  const recordless: KnownPlace = { name: "old home", detail: "", own: true };
  const nearest = nearestOwnHome([far, stranger, recordless, house("near", 10)], snapshot());
  assert.deepEqual(nearest, { name: "near", door: { x: 10, y: 64, z: 0 }, distance: 10 });
  assert.equal(nearestOwnHome([stranger, recordless], snapshot()), null);
});

test("a carried bed (family bed) offers sleep at night from 12542, not at 12541 (the bedtime edge)", () => {
  const before = view({ snapshot: snapshot({ inventory: bed, clock: { phase: "night", minutesUntilChange: 1, timeOfDay: 12_541 } }) });
  assert.equal(hasOption(before, "sleep"), false);
  const after = view({ snapshot: snapshot({ inventory: bed, clock: { phase: "night", minutesUntilChange: 1, timeOfDay: 12_542 } }) });
  assert.deepEqual(option(after, "sleep"), { label: "sleep", form: '{"skill":"sleep"}' });
});

test("before 12542 dig is bare and sleep is not offered", () => {
  const v = view({ snapshot: snapshot({ inventory: bed, clock: { phase: "day", minutesUntilChange: 6, timeOfDay: 12_100 } }) });
  assert.deepEqual(option(v, "dig an emergency shelter here"), { label: "dig an emergency shelter here", form: '{"skill":"dig_shelter"}' });
  assert.equal(hasOption(v, "sleep"), false);
  assert.ok(fact(v, "beds work in 0.4 min"));
});

test("a bed respawn at night offers sleep", () => {
  const v = view({ info: respawnInfo, snapshot: snapshot({ respawn: bedRespawn }) });
  assert.equal(hasOption(v, "sleep"), true);
});

test("no bed: no sleep", () => {
  const v = view({ info: respawnInfo, snapshot: snapshot({ respawn: { kind: "world_spawn", position: { x: 0, y: 64, z: 0 }, distance: 0 }, inventory: [] }) });
  assert.equal(hasOption(v, "sleep"), false);
});

test("low health never offers dig_shelter", () => {
  const v = view({ info: lowHealthInfo, snapshot: snapshot({ health: 6, inventory: bed }) });
  assert.equal(hasOption(v, "dig an emergency shelter here"), false);
});

test("low health at night is not a night event: no sleep and no beds fact, even with a bed carried", () => {
  const v = view({ info: lowHealthInfo, snapshot: snapshot({ health: 6, inventory: bed, clock: { phase: "night", minutesUntilChange: 1, timeOfDay: 13_000 } }) });
  assert.equal(hasOption(v, "sleep"), false);
  const early = view({ info: lowHealthInfo, snapshot: snapshot({ health: 6, inventory: bed, clock: { phase: "day", minutesUntilChange: 6, timeOfDay: 12_100 } }) });
  assert.equal(early.facts.some((text) => text.startsWith("beds work")), false);
});

test("no option has a minutes field and no wait skill", () => {
  const views = [
    view({ info: lowHealthInfo, snapshot: snapshot({ health: 6, food: 5, foods: [{ name: "bread", count: 2, points: 5, saturation: 6 }], inventory: bed, respawn: bedRespawn, lastDeath: death({ minutesAgo: 1 }) }), places: [house("Hillcrest", 3)] }),
    view({ info: respawnInfo, snapshot: snapshot({ inventory: bed, respawn: bedRespawn, lastDeath: death({ minutesAgo: 2 }) }), places: [house("Hillcrest", 3)] }),
    view({ objective: order("dig", "Bob"), ordinary: order("dig", "Bob") }),
  ];
  for (const v of views) {
    for (const entry of v.options) {
      const form = JSON.parse(entry.form) as Record<string, unknown>;
      assert.equal("minutes" in form, false);
      assert.notEqual(form.skill, "wait");
    }
  }
});

test("a daytime respawn has no night options", () => {
  const v = view({ info: respawnInfo, night: false, timeOfDay: 2_000, snapshot: snapshot({ inventory: bed, respawn: bedRespawn, clock: { phase: "day", minutesUntilChange: 9, timeOfDay: 2_000 } }) });
  assert.equal(hasOption(v, "sleep"), false);
  assert.equal(hasOption(v, "dig an emergency shelter here"), false);
});

test("a Nether respawn offers go back but no overworld-night options, and no home trip", () => {
  const v = view({
    info: respawnInfo, night: false, places: [house("Hillcrest", 3)],
    snapshot: snapshot({ dimension: "the_nether", clock: { phase: null, minutesUntilChange: null }, inventory: bed, respawn: bedRespawn, lastDeath: death({ dimension: "the_nether", minutesAgo: 3 }) }),
  });
  assert.ok(hasOption(v, "go back for your things"));
  assert.equal(hasOption(v, "sleep"), false);
  assert.equal(hasOption(v, "dig an emergency shelter here"), false);
  assert.equal(hasOption(v, "go home"), false);
  assert.ok(fact(v, "your home is in the overworld"));
});

test("respawn 3 min ago in this dimension: go back offered at the death position", () => {
  const v = view({ info: respawnInfo, snapshot: snapshot({ lastDeath: death({ minutesAgo: 3 }) }) });
  assert.deepEqual(option(v, "go back for your things"), { label: "go back for your things", form: '{"skill":"go_to","x":10,"y":64,"z":-4}' });
});

test("the dimension spelled minecraft:overworld matches overworld", () => {
  const v = view({ info: respawnInfo, places: [house("Hillcrest", 3)], snapshot: snapshot({ dimension: "minecraft:overworld", lastDeath: death({ dimension: "overworld", minutesAgo: 3 }) }) });
  assert.ok(hasOption(v, "go back for your things"));
  assert.ok(hasOption(v, "go home"));
});

test("the recovery window: 4 min still offers go back; 5 and 6 min drop it and say pick_up no longer takes them", () => {
  for (const minutesAgo of [4, 5, 6]) {
    const v = view({ info: respawnInfo, snapshot: snapshot({ lastDeath: death({ minutesAgo }) }) });
    assert.equal(hasOption(v, "go back for your things"), minutesAgo < 5, `go back at ${minutesAgo} min`);
    assert.equal(fact(v, "your things at 10 64 -4: pick_up no longer takes them (over 5 min)"), minutesAgo >= 5, `pick_up fact at ${minutesAgo} min`);
  }
});

test("different-dimension death does not claim items vanished", () => {
  const v = view({ info: respawnInfo, snapshot: snapshot({ lastDeath: death({ dimension: "the_nether", minutesAgo: 1 }) }) });
  assert.ok(fact(v, "your things are in the_nether"));
  assert.equal(hasOption(v, "go back for your things"), false);
  assert.equal(v.facts.some((text) => text.includes("pick_up")), false);
});

test("a stale death in another dimension gives both facts, and no go back", () => {
  const v = view({ info: respawnInfo, snapshot: snapshot({ lastDeath: death({ dimension: "the_nether", minutesAgo: 6 }) }) });
  assert.ok(fact(v, "your things are in the_nether"));
  assert.ok(fact(v, "your things at 10 64 -4: pick_up no longer takes them (over 5 min)"));
  assert.equal(hasOption(v, "go back for your things"), false);
});

test("a multiline home name stays one bounded line", () => {
  const v = view({ places: [house("Home\nTwo".repeat(40), 3)] });
  for (const text of v.facts) assert.doesNotMatch(text, /[\n\r]/u);
  const home = v.facts.find((text) => text.startsWith('your home "'));
  assert.ok(home !== undefined);
  const name = home.slice('your home "'.length, home.indexOf('" is '));
  assert.ok(name.length <= 120, `name is ${name.length} characters`);
});

test("low health with food: eat the most filling", () => {
  const v = view({
    info: lowHealthInfo,
    snapshot: snapshot({ health: 6, food: 12, foods: [{ name: "bread", count: 2, points: 5, saturation: 6 }, { name: "cooked_beef", count: 1, points: 8, saturation: 12 }] }),
  });
  assert.deepEqual(option(v, "eat"), { label: "eat", form: '{"skill":"eat","food":"cooked_beef"}' });
});

test("food 5: both hunger facts", () => {
  const v = view({ info: lowHealthInfo, snapshot: snapshot({ health: 6, food: 5 }) });
  assert.ok(fact(v, "food 5/20: you do not heal by yourself"));
  assert.ok(fact(v, "food 5/20: you cannot sprint"));
});

test("hunger thresholds: no heal from 18 up, no sprint from 7 up, each side of the bound", () => {
  const at = (food: number) => view({ info: lowHealthInfo, snapshot: snapshot({ health: 6, food }) });
  assert.ok(fact(at(17), "food 17/20: you do not heal by yourself"));
  assert.equal(at(18).facts.some((text) => text.includes("do not heal")), false);
  assert.ok(fact(at(6), "food 6/20: you cannot sprint"));
  assert.equal(at(7).facts.some((text) => text.includes("cannot sprint")), false);
});

test("eat from 19 down and not at 20 (the bound of food < 20)", () => {
  const foods = [{ name: "bread", count: 2, points: 5, saturation: 6 }];
  assert.equal(hasOption(view({ info: lowHealthInfo, snapshot: snapshot({ health: 6, food: 19, foods }) }), "eat"), true);
  assert.equal(hasOption(view({ info: lowHealthInfo, snapshot: snapshot({ health: 6, food: 20, foods }) }), "eat"), false);
});

test("deaths fact only after a death", () => {
  assert.equal(view().facts.some((text) => text.includes("times since you woke")), false);
  assert.ok(fact(view({ deaths: { total: 1, atNight: 0 } }), "you died 1 times since you woke, 0 of them at night"));
  assert.ok(fact(view({ deaths: { total: 2, atNight: 1 } }), "you died 2 times since you woke, 1 of them at night"));
});

test("not at low health: no hunger facts and no eat", () => {
  const v = view({ snapshot: snapshot({ food: 5, foods: [{ name: "bread", count: 2, points: 5, saturation: 6 }] }) });
  assert.equal(v.facts.some((text) => text.includes("heal by yourself")), false);
  assert.equal(hasOption(v, "eat"), false);
});

test("a persona without dig_shelter or sleep: neither offered", () => {
  const skills = SKILL_NAMES.filter((skill) => skill !== "dig_shelter" && skill !== "sleep");
  const v = view({ skills, snapshot: snapshot({ inventory: bed }) });
  assert.equal(hasOption(v, "sleep"), false);
  assert.equal(hasOption(v, "dig an emergency shelter here"), false);
});

test("a pushed situation: option 1 reads leave this event", () => {
  const v = view({ pushed: true, objective: order("mine iron"), ordinary: order("mine iron") });
  assert.deepEqual(v.options[0], { label: "leave this event", form: '{"done":"carry on"}' });
});

test("boldness is shown with its scale", () => {
  assert.equal(view({ boldness: "cautious" }).weigh[0], "boldness cautious (cautious, steady or bold)");
});

test("boldness is the only difference", () => {
  const cautious = view({ boldness: "cautious", snapshot: snapshot({ inventory: bed }) });
  const bold = view({ boldness: "bold", snapshot: snapshot({ inventory: bed }) });
  assert.deepEqual(cautious.facts, bold.facts);
  assert.deepEqual(cautious.options, bold.options);
  assert.notEqual(cautious.weigh[0], bold.weigh[0]);
  assert.deepEqual(cautious.weigh.slice(1), bold.weigh.slice(1));
});

test("gear: each part as the snapshot reports it, null points are a worn piece with unknown points", () => {
  const worn = [{ slot: "torso", item: "iron_chestplate" }];
  const rows: readonly [Partial<BotSnapshot>, string][] = [
    [{ armourPoints: 15, armourToughness: 2, combat: { melee: "iron_sword", bow: "bow", arrows: 12, shield: "shield" } }, "gear: armour 15 points, toughness 2, melee iron_sword, bow with 12 arrows, shield"],
    [{ armourPoints: 0, combat: { melee: null, bow: null, arrows: 0, shield: null } }, "gear: armour 0 points, bare hands"],
    [{ combat: { melee: null, bow: "bow", arrows: 0, shield: null } }, "gear: bare hands, bow, no arrows"],
    [{ armourPoints: null, armour: { worn, carried: [] }, combat: { melee: "iron_sword", bow: null, arrows: 0, shield: null } }, "gear: armour worn, points unknown, melee iron_sword"],
    [{ armourPoints: null, armourToughness: 2 }, "gear: armour worn, points unknown, toughness 2"],
    [{ armourPoints: null, armour: { worn: [{ slot: "torso", item: null }], carried: [] } }, "gear: armour worn, points unknown"],
    [{ armourPoints: 5 }, "gear: armour 5 points"],
  ];
  for (const [facts, expected] of rows) assert.equal(gearFact(snapshot(facts)), expected, expected);
});

test("an older runtime: gear unknown", () => {
  const { armourPoints: _points, combat: _combat, armour: _armour, ...older } = snapshot();
  assert.equal(gearFact(older), "gear: unknown");
});

test("whose work comes from the ordinary work, not the running situation", () => {
  const v = view({ objective: order("Shelter for the night"), ordinary: order("build the farm", "Bob") });
  assert.equal(v.weigh[2], "order from Bob");
  assert.ok(v.options[0]!.label.endsWith(" (Bob hears what you decide)"));
});
