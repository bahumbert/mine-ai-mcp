import assert from "node:assert/strict";
import test from "node:test";
import { compileScenario, scenarioSchema, type Scenario, type ScenarioInput } from "mine-labs";
import { FRESH_SERVER_GAMERULES } from "./gamerule-defaults.ts";
import { settingsCommands, settingsOf } from "./settings.ts";

function scenarioWith(fields: Partial<ScenarioInput> = {}): Scenario {
  return scenarioSchema.parse({
    players: [{ name: "Actor", pos: [0, -60, 0] }],
    goal: { kind: "completion" },
    client: { command: "bun" },
    ...fields,
  });
}

const settingsOfScenario = (fields: Partial<ScenarioInput> = {}) => settingsOf(scenarioWith(fields), FRESH_SERVER_GAMERULES);

test("the settings verbs of setup leave the lane's commands and become the server's settings", () => {
  const { settings, scenario } = settingsOfScenario({
    setup: ["setblock 0 -60 0 stone", "difficulty peaceful", "tick rate 4", "gamerule keepInventory true", "time set midnight", "weather rain 600", "fill 0 -60 0 1 -60 1 air"],
  });
  assert.deepEqual(scenario.setup, ["setblock 0 -60 0 stone", "fill 0 -60 0 1 -60 1 air"]);
  assert.equal(settings.difficulty, "peaceful");
  assert.equal(settings.tickRate, 4);
  assert.equal(settings.gamerules.keepInventory, "true");
  assert.equal(settings.time, "midnight");
  assert.equal(settings.weather, "rain 600");
});

test("a setup verb with arguments the lift does not know stays in setup, where the command shift refuses it", () => {
  const { scenario } = settingsOfScenario({ setup: ["time add 5", "difficulty", "tick step 5", "weather", "gamerule keepInventory"] });
  assert.equal(scenario.setup.length, 5);
});

test("tick and reset are never lifted: a scenario that changes a setting during its trial keeps the command for the shift to refuse", () => {
  const { scenario } = settingsOfScenario({ tick: ["gamerule doFireTick false"], reset: ["difficulty hard"] });
  assert.deepEqual(scenario.tick, ["gamerule doFireTick false"]);
  assert.deepEqual(scenario.reset, ["difficulty hard"]);
});

test("a lifted value wins over world.*, as it does when Mine Labs runs setup after the world settings", () => {
  const { settings, scenario } = settingsOfScenario({ world: { difficulty: "normal", time: "noon", gamerules: { keepInventory: false } }, setup: ["difficulty peaceful", "time set midnight", "gamerule keepInventory true"] });
  assert.equal(settings.difficulty, "peaceful");
  assert.equal(settings.time, "midnight");
  assert.equal(settings.gamerules.keepInventory, "true");
  const commands = compileScenario(scenario).setup;
  assert.ok(commands.includes("difficulty peaceful") && !commands.includes("difficulty normal"));
  assert.ok(commands.includes("time set midnight") && !commands.includes("time set noon"));
  assert.ok(commands.includes("gamerule keepInventory true") && !commands.includes("gamerule keepInventory false"));
});

test("the lane scenario carries every effective value, so Mine Labs' per-trial settings re-set the key's values and no others", () => {
  const { settings, scenario } = settingsOfScenario({ world: { gamerules: { naturalRegeneration: false } } });
  assert.equal(scenario.world.time, settings.time);
  assert.equal(scenario.world.difficulty, settings.difficulty);
  assert.deepEqual(scenario.world.gamerules, settings.gamerules);
  assert.equal(scenario.world.gamerules.doDaylightCycle, "true");
});

test("a scenario with world.difficulty normal and setup difficulty peaceful gives peaceful in the key and in the lane setup", () => {
  const { settings, scenario } = settingsOfScenario({ world: { difficulty: "normal" }, setup: ["difficulty peaceful"] });
  assert.equal(settings.difficulty, "peaceful");
  assert.deepEqual(compileScenario(scenario).setup.filter((command) => command.startsWith("difficulty")), ["difficulty peaceful"]);
});

test("an unset rule counts at the server's default, so unset and explicitly-default give one key", () => {
  const unset = settingsOfScenario().key;
  assert.equal(settingsOfScenario({ world: { gamerules: { naturalRegeneration: true } } }).key, unset);
  assert.equal(settingsOfScenario({ setup: ["gamerule naturalRegeneration true"] }).key, unset);
  assert.notEqual(settingsOfScenario({ world: { gamerules: { naturalRegeneration: false } } }).key, unset);
});

test("doMobSpawning unset is false on a flat world, as Mine Labs sets it (one key with the explicit false), and the server default on a default world", () => {
  const unset = settingsOfScenario();
  assert.equal(unset.settings.gamerules.doMobSpawning, "false");
  assert.equal(settingsOfScenario({ world: { gamerules: { doMobSpawning: false } } }).key, unset.key);
  assert.notEqual(settingsOfScenario({ world: { gamerules: { doMobSpawning: true } } }).key, unset.key);
  assert.equal(settingsOfScenario({ world: { type: "default" } }).settings.gamerules.doMobSpawning, "true");
});

test("the rules Mine Labs or the daemon own are in neither the key nor the lane scenario", () => {
  const { settings, scenario, key } = settingsOfScenario({ world: { gamerules: { sendCommandFeedback: true } }, setup: ["gamerule commandModificationBlockLimit 5"] });
  for (const rule of ["sendCommandFeedback", "commandModificationBlockLimit", "commandBlockOutput"]) {
    assert.ok(!(rule in settings.gamerules), rule);
    assert.ok(!(rule in scenario.world.gamerules), rule);
    assert.ok(!key.includes(rule), rule);
  }
});

test("a set weather stops the weather cycle in the key's rules", () => {
  const { settings, key } = settingsOfScenario({ setup: ["weather clear"] });
  assert.equal(settings.gamerules.doWeatherCycle, "false");
  assert.notEqual(key, settingsOfScenario().key);
  assert.equal(settingsOfScenario({ setup: ["weather clear", "gamerule doWeatherCycle false"] }).key, key);
});

test("the key does not depend on the order the rules were written in", () => {
  const a = settingsOfScenario({ world: { gamerules: { keepInventory: true, randomTickSpeed: 0 } } }).key;
  const b = settingsOfScenario({ world: { gamerules: { randomTickSpeed: 0, keepInventory: true } } }).key;
  assert.equal(a, b);
});

test("version, world type, seed, structures, spawn, time, difficulty, weather and tick rate each split the key", () => {
  const base = settingsOfScenario().key;
  const variants: Array<Partial<ScenarioInput>> = [
    { minecraft: { version: "1.21.5" } },
    { world: { type: "default" } },
    { world: { type: "default", seed: 1 } },
    { world: { structures: true } },
    { world: { spawn: [0, -60, 0] } },
    { world: { time: "midnight" } },
    { world: { difficulty: "hard" } },
    { setup: ["weather rain"] },
    { setup: ["tick rate 4"] },
  ];
  const keys = new Set([base, ...variants.map((fields) => settingsOfScenario(fields).key)]);
  assert.equal(keys.size, variants.length + 1);
});

test("settingsOf leaves the scenario it was given as it was", () => {
  const original = scenarioWith({ setup: ["difficulty peaceful", "setblock 0 -60 0 stone"] });
  const before = structuredClone(original);
  settingsOf(original, FRESH_SERVER_GAMERULES);
  assert.deepEqual(original, before);
});

/** The server state after commands, for the rules the settings cover. */
function applied(commands: readonly string[]): Record<string, string> {
  const state: Record<string, string> = {};
  for (const command of commands) {
    const [verb, a, b] = command.split(" ");
    if (verb === "gamerule") state[a!] = b!;
    if (verb === "difficulty") state.difficulty = a!;
    if (verb === "time") state.time = b!;
  }
  return state;
}

test("a server built with settingsCommands, then one lane's setup, holds every key rule at its key value", () => {
  const { settings, scenario } = settingsOfScenario({ world: { difficulty: "hard", gamerules: { keepInventory: true } }, setup: ["gamerule randomTickSpeed 0", "difficulty peaceful", "weather clear"] });
  const state = applied([...settingsCommands(settings), ...compileScenario(scenario).setup]);
  for (const [rule, value] of Object.entries(settings.gamerules)) assert.equal(state[rule], value, rule);
  assert.equal(state.difficulty, settings.difficulty);
  assert.equal(state.time, settings.time);
});

test("settingsCommands names weather and tick rate only when the key sets them", () => {
  const plain = settingsCommands(settingsOfScenario().settings);
  assert.ok(!plain.some((command) => command.startsWith("weather") || command.startsWith("tick rate")));
  const set = settingsCommands(settingsOfScenario({ setup: ["weather thunder", "tick rate 16"] }).settings);
  assert.ok(set.includes("weather thunder"));
  assert.ok(set.includes("tick rate 16"));
});
