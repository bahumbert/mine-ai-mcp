import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadScenario, type Scenario } from "mine-labs";
import { laneOf } from "../arena/lanes.ts";
import { loadAllScenarios } from "../arena/all-scenarios.ts";
import { FRESH_SERVER_GAMERULES } from "../arena/gamerule-defaults.ts";
import { settingsOf } from "../arena/settings.ts";
import { shiftScenario } from "../arena/shift-scenario.ts";
import { changesWorldDuringTrial, gameruleNamesOf, isTimingTrial, parseGameruleAnswer, placeScenario, reservePlacement, type ArenaPorts } from "./placement.ts";
import { fixtureScenario } from "./scenario-fixture.ts";

const MINECRAFT_DIR = fileURLToPath(new URL("..", import.meta.url));
const OUR_CLIENT_HOST = path.join(MINECRAFT_DIR, "client-host.ts");
const LEGACY_SMELT_YAML = fileURLToPath(new URL("../../../scenarios/flat/craft/smelt-batch-normal.yaml", import.meta.url));

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

function withClient(scenario: Scenario, client: Partial<Scenario["client"]>): Scenario {
  return { ...scenario, client: { ...scenario.client, ...client } };
}

function ownReason(placement: ReturnType<typeof placeScenario>): string {
  assert.equal(placement.kind, "own");
  return placement.kind === "own" ? placement.reason : "";
}

test("a legacy scenario whose client never reads the arena frame gets a server of its own with the reason, whether or not the shift would accept it", async () => {
  const legacy = await loadScenario(LEGACY_SMELT_YAML);
  const shiftRefuses: ArenaPorts = { ...accepting, shiftScenario: () => ({ ok: false, reason: "world.type is default" }) };
  for (const ports of [accepting, shiftRefuses]) {
    const reason = ownReason(placeScenario(legacy, {}, ports));
    assert.match(reason, /client .*client-host\.ts does not read the arena frame \(MINE_AI_ARENA\)/u);
    assert.match(reason, /coordinates would stay at offset zero/u);
  }
});

const UNUSABLE_CLIENTS: readonly { readonly what: string; readonly client: Partial<Scenario["client"]>; readonly reason: RegExp }[] = [
  { what: "an entry that does not exist", client: { args: ["no-such-host.ts"] }, reason: /its client entry .*no-such-host\.ts could not be resolved \(ENOENT\)/u },
  { what: "a flag in place of the entry", client: { args: ["--smol", "client-host.ts"] }, reason: /its client entry .*--smol could not be resolved/u },
  { what: "a command other than bun", client: { command: "node" }, reason: /command node.*arena frame/u },
  { what: "no arguments", client: { args: [] }, reason: /no entry.*arena frame/u },
];

for (const { what, client, reason } of UNUSABLE_CLIENTS) {
  test(`a client with ${what} is a server of its own with the reason, and placement does not throw`, () => {
    assert.match(ownReason(placeScenario(withClient(fixtureScenario(10), client), {}, accepting)), reason);
  });
}

test("our client host named through a template, a symlink or a .. segment stays on a lane", async () => {
  const templated = await loadScenario(path.join(MINECRAFT_DIR, "scenarios/collect/parkour-ore-gap.yaml"));
  assert.equal(placeScenario(templated, {}, accepting).kind, "lane");
  const folder = mkdtempSync(path.join(tmpdir(), "placement-client-"));
  try {
    symlinkSync(OUR_CLIENT_HOST, path.join(folder, "host-link.ts"));
    assert.equal(placeScenario(withClient(fixtureScenario(10), { cwd: folder, args: ["host-link.ts"] }), {}, accepting).kind, "lane");
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
  assert.equal(placeScenario(withClient(fixtureScenario(10), { cwd: MINECRAFT_DIR, args: ["shared/../client-host.ts"] }), {}, accepting).kind, "lane");
});

test("no scenario of the census moves to a server of its own because of its client", async () => {
  for (const { file, scenario } of await loadAllScenarios()) {
    const shiftable = shiftScenario(settingsOf(scenario, FRESH_SERVER_GAMERULES).scenario, laneOf(1)).ok;
    assert.equal(placeScenario(scenario, FRESH_SERVER_GAMERULES).kind === "lane", shiftable, file);
  }
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
