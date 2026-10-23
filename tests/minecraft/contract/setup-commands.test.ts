import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { CONTRACT_CHECKS, contractCheckNamed } from "./checks.ts";
import { contractClientArgs, contractTags, setupCommands } from "./setup-commands.ts";

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
    assert.deepEqual(scenario.tags, contractTags(check), `${file}: tags`);
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

test("setupCommands fills a container's slots from 0 after its setblock, splitting at the stack size, and a fixture without containers writes none", () => {
  const cells = { "0,-60,0": "chest" };
  const { setup } = setupCommands({ cells, carried: {}, containers: { "0,-60,0": { cobblestone: 70, torch: 3 } }, position: [0.5, -60, 0.5] });
  assert.deepEqual(setup.slice(-4), [
    "setblock 0 -60 0 chest",
    "item replace block 0 -60 0 container.0 with cobblestone 64",
    "item replace block 0 -60 0 container.1 with cobblestone 6",
    "item replace block 0 -60 0 container.2 with torch 3",
  ]);
  assert.equal(setupCommands({ cells, carried: {}, position: [0.5, -60, 0.5] }).setup.length, 3);
  assert.throws(() => setupCommands({ cells: {}, carried: {}, containers: { "0,-60,0": { dirt: 1 } }, position: [0.5, -60, 0.5] }), /no block in cells/);
});

test("setupCommands hands an entity's nbt to the YAML and leaves the key out of an entity with none", () => {
  const { entities } = setupCommands({
    cells: {},
    carried: {},
    position: [0.5, -60, 0.5],
    entities: [
      { name: "oak_boat", position: [2.5, -60, 0.5], nbt: '{Passengers:[{id:"minecraft:armor_stand"}]}' },
      { name: "oak_boat", position: [-2.5, -60, 0.5] },
    ],
  });
  assert.deepEqual(entities, [
    { type: "oak_boat", pos: [2.5, -60, 0.5], nbt: '{Passengers:[{id:"minecraft:armor_stand"}]}' },
    { type: "oak_boat", pos: [-2.5, -60, 0.5] },
  ]);
});

test("setupCommands summons an entity's passengers with it as Passengers nbt, and refuses passengers beside a raw nbt", () => {
  const boat = { name: "oak_boat", position: [2.5, -60, 0.5] as const };
  const { entities } = setupCommands({ cells: {}, carried: {}, position: [0.5, -60, 0.5], entities: [{ ...boat, passengers: ["armor_stand", "armor_stand"] }] });
  assert.deepEqual(entities, [{ type: "oak_boat", pos: [2.5, -60, 0.5], nbt: '{Passengers:[{id:"minecraft:armor_stand"},{id:"minecraft:armor_stand"}]}' }]);
  assert.throws(() => setupCommands({ cells: {}, carried: {}, position: [0.5, -60, 0.5], entities: [{ ...boat, nbt: "{}", passengers: ["armor_stand"] }] }), /nbt or passengers/);
});

test("setupCommands sets the difficulty to easy when a hostile mob is summoned (a peaceful world removes it) and leaves it alone for a boat", () => {
  const base = { cells: {}, carried: {}, position: [0.5, -60, 0.5] as const };
  const withZombie = setupCommands({ ...base, entities: [{ name: "zombie", position: [2.5, -60, 0.5] }] }).setup;
  assert.ok(withZombie.includes("difficulty easy"));
  assert.equal(setupCommands({ ...base, entities: [{ name: "oak_boat", position: [2.5, -60, 0.5] }] }).setup.some((line) => line.startsWith("difficulty")), false);
  assert.equal(setupCommands(base).setup.some((line) => line.startsWith("difficulty")), false);
});
