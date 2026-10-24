import test from "node:test";
import assert from "node:assert/strict";
import type { Scenario } from "mine-labs";
import { laneOf } from "../arena/lanes.ts";
import { settingsOf } from "../arena/settings.ts";
import { changesWorldDuringTrial, gameruleNamesOf, isTimingTrial, parseGameruleAnswer, placeScenario, reservePlacement, type ArenaPorts } from "./placement.ts";
import { fixtureScenario } from "./scenario-fixture.ts";

const accepting: ArenaPorts = {
  settingsOf: (scenario, defaults) => ({ ...settingsOf(scenario, defaults), key: "key-of-" + scenario.name }),
  shiftScenario: (scenario, lane) => ({ ok: true, scenario: { ...scenario, name: `${scenario.name}@${lane.index}` } }),
  canResetScenario: () => true,
  worldCompatibilityKey: scenario => `world-of-${scenario.name}`,
};

function withCommands(scenario: Scenario, field: "tick" | "reset", commands: string[]): Scenario {
  return { ...scenario, [field]: commands };
}

test("a scenario the shift accepts is placed on a lane of its settings key, with the lifted scenario", () => {
  const placement = placeScenario(fixtureScenario(10, "a"), {}, accepting);
  assert.equal(placement.kind, "lane");
  assert.equal(placement.key, "key-of-a");
  assert.equal(placement.kind === "lane" ? placement.scenario.name : "", "a");
});

test("the probe shift uses lane 1 and a refusal becomes a server of its own with the reason", () => {
  let probed = 0;
  const refusing: ArenaPorts = { ...accepting, shiftScenario: (_scenario, lane) => { probed = lane.index; return { ok: false, reason: "world.type is default" }; } };
  const placement = placeScenario(fixtureScenario(10, "nat"), {}, refusing);
  assert.equal(probed, laneOf(1).index);
  assert.deepEqual(placement, { kind: "own", key: "own:world-of-nat", reason: "world.type is default", reusable: true });
});

test("a refused scenario that cannot be reset is not reusable", () => {
  const refusing: ArenaPorts = { ...accepting, canResetScenario: () => false, shiftScenario: () => ({ ok: false, reason: "no" }) };
  const placement = placeScenario(fixtureScenario(10), {}, refusing);
  assert.equal(placement.kind === "own" && placement.reusable, false);
});

test("a settings verb in tick or reset makes a refused scenario non-reusable (it changes the world during its trial)", () => {
  const refusing: ArenaPorts = { ...accepting, shiftScenario: () => ({ ok: false, reason: "gamerule in tick" }) };
  const ticking = withCommands(fixtureScenario(10), "tick", ["gamerule doDaylightCycle false"]);
  const placement = placeScenario(ticking, {}, refusing);
  assert.equal(placement.kind === "own" && placement.reusable, false);
});

test("changesWorldDuringTrial finds a settings verb at the head of a command or after execute ... run", () => {
  const base = fixtureScenario(10);
  assert.equal(changesWorldDuringTrial(withCommands(base, "reset", ["time set day"])), true);
  assert.equal(changesWorldDuringTrial(withCommands(base, "tick", ["execute as @a at @s run weather clear"])), true);
  assert.equal(changesWorldDuringTrial(withCommands(base, "tick", ["gamemode spectator @a[name=!Actor]"])), false);
  assert.equal(changesWorldDuringTrial(withCommands(base, "reset", ["fill 0 -60 0 1 -60 1 air"])), false);
});

test("a scenario whose settings cannot be read is placed on a server of its own", () => {
  const broken: ArenaPorts = { ...accepting, settingsOf: () => { throw new Error("odd rule"); } };
  const placement = placeScenario(fixtureScenario(10), {}, broken);
  assert.equal(placement.kind, "own");
  assert.match(placement.kind === "own" ? placement.reason : "", /odd rule/u);
});

test("a gamerule answer yields its value", () => {
  assert.equal(parseGameruleAnswer("Gamerule doFireTick is currently set to: true"), "true");
  assert.equal(parseGameruleAnswer("Gamerule randomTickSpeed is currently set to: 3"), "3");
});

test("an answer that is not a gamerule value is null, so a defaults read can name the rule it failed on", () => {
  assert.equal(parseGameruleAnswer("Incorrect argument for command"), null);
});

test("the gamerules a scenario sets, and Mine Labs' flat-world doMobSpawning, are found by asking its settings with no defaults", () => {
  const scenario = { ...fixtureScenario(10), world: { ...fixtureScenario(10).world, gamerules: { doFireTick: false, randomTickSpeed: 0 } } };
  assert.deepEqual(gameruleNamesOf(scenario).sort(), ["doFireTick", "doMobSpawning", "randomTickSpeed"]);
});

test("a scenario whose settings cannot be read names no rule", () => {
  const broken: ArenaPorts = { ...accepting, settingsOf: () => { throw new Error("odd"); } };
  assert.deepEqual(gameruleNamesOf(fixtureScenario(10), broken), []);
});

const refusing: ArenaPorts = { ...accepting, shiftScenario: () => ({ ok: false, reason: "tagged 'exclusive'" }) };

test("a refused scenario tagged exclusive is a timing placement, and one refused for another reason is not", () => {
  const tagged = placeScenario({ ...fixtureScenario(10, "t"), tags: ["exclusive"] }, {}, refusing);
  assert.equal(tagged.kind === "own" && tagged.exclusive, true);
  assert.equal(isTimingTrial(tagged, false), true);
  const plainRefused = placeScenario(fixtureScenario(10, "n"), {}, refusing);
  assert.equal(isTimingTrial(plainRefused, false), false);
  assert.equal(isTimingTrial(plainRefused, true), true, "every trial of a locked batch times something");
  assert.equal(isTimingTrial(placeScenario(fixtureScenario(10, "l"), {}, accepting), false), false);
});

test("a locked batch's placement gets a pool key of its own that no other batch's placement has, and the world key inside it is kept", () => {
  const lane = placeScenario(fixtureScenario(10, "a"), {}, accepting);
  const one = reservePlacement(lane, 3);
  const two = reservePlacement(lane, 4);
  assert.notEqual(one.key, two.key);
  assert.notEqual(one.key, lane.key);
  assert.match(one.key, /^key-of-a/u);
  assert.equal(one.reservedFor, 3);
  assert.equal(lane.reservedFor, undefined, "the original placement is not changed");
});
