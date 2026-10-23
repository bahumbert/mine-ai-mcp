import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { CONTRACT_CHECKS, contractCheckNamed } from "./checks.ts";
import { contractClientArgs, setupCommands } from "./setup-commands.ts";

const SCENARIOS = path.join(path.dirname(fileURLToPath(import.meta.url)), "scenarios");

interface ContractYaml {
  readonly params: { readonly check: string };
  readonly setup: readonly string[];
  readonly entities?: readonly unknown[];
  readonly players: readonly { readonly pos: unknown; readonly op: boolean; readonly inventory?: readonly unknown[] }[];
  readonly tags: readonly string[];
  readonly client: { readonly args: readonly string[] };
}

function readContractYaml(file: string): ContractYaml {
  return parse(readFileSync(path.join(SCENARIOS, file), "utf8")) as ContractYaml;
}

test("every contract check has its scenario YAML, named after it", () => {
  const files = new Set(readdirSync(SCENARIOS));
  assert.deepEqual(CONTRACT_CHECKS.filter(({ name }) => !files.has(`${name}.yaml`)).map(({ name }) => name), []);
});

test("every contract YAML arranges its check's fixture: setup lines, the op player's place and stacks, the entities", () => {
  for (const file of readdirSync(SCENARIOS)) {
    const scenario = readContractYaml(file);
    assert.equal(file, `${scenario.params.check}.yaml`, `${file} runs check ${scenario.params.check}`);
    const check = contractCheckNamed(scenario.params.check);
    const expected = setupCommands(check.fixture);
    assert.deepEqual(scenario.client.args, contractClientArgs(check), `${file}: client args`);
    assert.deepEqual(scenario.setup, expected.setup, `${file}: setup differs from setupCommands(fixture)`);
    assert.deepEqual(scenario.entities ?? [], expected.entities, `${file}: entities`);
    assert.equal(scenario.players.length, 1, `${file}: one player`);
    const [player] = scenario.players;
    assert.deepEqual(player!.pos, expected.player.pos, `${file}: player pos`);
    assert.deepEqual(player!.inventory ?? [], expected.player.inventory, `${file}: inventory`);
    // The real subject sends op commands (`setblock`, `execute ... on vehicle`).
    assert.equal(player!.op, true, `${file}: the player is op`);
    assert.ok(scenario.tags.includes("contract"), `${file}: tagged contract`);
  }
});

test("setupCommands writes block states in command form and refuses a cell outside the arena", () => {
  const { setup } = setupCommands({
    cells: { "0,-60,2": { name: "snow", properties: { layers: 1 } } },
    carried: { torch: 5 },
    position: [0.5, -60, 0.5],
  });
  assert.equal(setup.at(-1), "setblock 0 -60 2 snow[layers=1]");
  assert.throws(() => setupCommands({ cells: { "9,-60,0": "dirt" }, carried: {}, position: [0.5, -60, 0.5] }), /outside the contract arena/);
});

test("setupCommands sets the day time, the day cycle and the weather after the cells, and none of them for a fixture that names none", () => {
  const bare = setupCommands({ cells: { "0,-60,2": "dirt" }, carried: {}, position: [0.5, -60, 0.5] }).setup;
  assert.equal(bare.some((line) => /^(time|weather|gamerule)/u.test(line)), false);
  const { setup } = setupCommands({
    cells: { "0,-60,2": "dirt" },
    carried: {},
    position: [0.5, -60, 0.5],
    timeOfDay: 14_000,
    daylightCycle: true,
    weather: "thunder",
  });
  assert.deepEqual(setup.slice(bare.length), ["gamerule doDaylightCycle true", "time set 14000", "weather thunder"]);
});
