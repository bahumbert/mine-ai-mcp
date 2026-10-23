import assert from "node:assert/strict";
import test from "node:test";
import { loadAllScenarios } from "./all-scenarios.ts";
import { FRESH_SERVER_GAMERULES } from "./gamerule-defaults.ts";
import { settingsOf } from "./settings.ts";

const all = await loadAllScenarios();
const settings = all.map(({ file, scenario }) => ({ file, ...settingsOf(scenario, FRESH_SERVER_GAMERULES) }));

/** The settings exactly as the YAML writes them (an unset rule and its default count apart), the number of worlds before merging. */
const writtenKeys = new Set(
  all.map(({ scenario }) => {
    const { world } = scenario;
    const lines = scenario.setup.filter((line) => /^(time|difficulty|gamerule|weather|tick) /u.test(line));
    return JSON.stringify([world.type, world.seed, world.structures, world.spawn, world.difficulty, world.time, Object.entries(world.gamerules).sort(), lines.sort()]);
  }),
);
const keys = new Set(settings.map(({ key }) => key));

test(`the ${all.length} scenarios need ${keys.size} settings keys (${writtenKeys.size} distinct written settings before unset rules merged)`, () => {
  assert.ok(keys.size >= 1);
  assert.ok(keys.size <= writtenKeys.size, "merging unset rules must never make more keys");
});

test("every setup line that sets time, difficulty, a rule, weather or tick rate leaves the lane setup and is held by the key", () => {
  for (const { file, settings: held, scenario: lane } of settings) {
    const original = all.find((entry) => entry.file === file)!.scenario;
    assert.deepEqual(lane.setup, original.setup.filter((line) => !/^(time set \S+|difficulty \w+|gamerule \S+ \S+|weather \w+( \S+)?|tick rate [\d.]+)$/u.test(line)), file);
    for (const line of original.setup.filter((line) => /^tick rate /u.test(line))) assert.equal(held.tickRate, Number(line.split(" ")[2]), file);
    for (const line of original.setup.filter((line) => /^difficulty /u.test(line))) assert.equal(held.difficulty, line.split(" ")[1], file);
  }
});

test("a scenario that sets tick rate or difficulty in setup is found, so the lift is exercised on real files", () => {
  const withTickRate = all.filter(({ scenario }) => scenario.setup.some((line) => line.startsWith("tick rate "))).length;
  const withDifficulty = all.filter(({ scenario }) => scenario.setup.some((line) => line.startsWith("difficulty "))).length;
  assert.ok(withTickRate >= 1 && withDifficulty >= 1, `tick rate in ${withTickRate} files, difficulty in ${withDifficulty}`);
});
