// check-reads: scenarios/**/*.yaml, scenarios/**/*.ts, tests/minecraft/scenarios/**/*.yaml
/**
 * A hunt against a hostile mob needs a shield carried by each hunting player, or the hunt says it allows none: the
 * admission gate (`shieldRefusal`, `shield-gate.ts`) refuses the rest before the first step. This census walks every
 * scenario YAML and the driver modules each runs, so a fixture that names such a hunt without one fails here, not in
 * a live run (plan 2026-11-18-scenario-reds-part2-a6 T13q).
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { loadScenario, scenarioSchema, type Scenario } from "mine-labs";
import type { Bot } from "mineflayer";
import { isHostileSpecies } from "../../src/survival/perception/combat/threats.ts";
import { createFakeBot } from "../../src/test-support/fake-bot/index.ts";
import { hasItemFamily } from "../../src/world/item-families.ts";
import { loadAllScenarios } from "../../tests/minecraft/arena/all-scenarios.ts";

/** One scenario, its file (from the repository root) and the mobs its hunts name. */
interface ScenarioEntry {
  readonly file: string;
  readonly scenario: Scenario;
  readonly mobs: readonly string[];
}

type PlayerSpec = Scenario["players"][number];

const REPOSITORY = path.resolve(import.meta.dirname, "..", "..");
const SCENARIO_TREE = path.join(REPOSITORY, "scenarios");
/** The drivers of this tree are modules, read through `readModule`, not scenarios. */
const DRIVER_SOURCE_DIRECTORY = path.join(SCENARIO_TREE, "src");
/** A `mob_name` request literal in a driver module, such as `{ mob_name: "zombie", drop_name: ... }`. */
const DRIVER_MOB_LITERAL = /mob_name:\s*"([a-z0-9_]+)"/g;
const SHIELD_FAMILY = "shield";

const readModule = (file: string): string => readFileSync(file, "utf8");

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

/** The mobs a scenario's hunts name: `params.mob_name`, `params.input.mob_name`, and each literal of its driver modules. */
function huntedMobs(scenario: Scenario, yamlDir: string, readDriver: (file: string) => string): string[] {
  const named = [scenario.params.mob_name, recordOf(scenario.params.input)?.mob_name].filter(isString);
  const cwd = path.resolve(yamlDir, scenario.client.cwd ?? ".");
  const literals = scenario.client.args
    .filter((arg) => arg.endsWith(".ts"))
    .flatMap((arg) => [...readDriver(path.resolve(cwd, arg)).matchAll(DRIVER_MOB_LITERAL)].map((match) => match[1]!));
  return [...new Set([...named, ...literals])];
}

function entryOf(file: string, scenario: Scenario, yamlDir: string, readDriver: (file: string) => string = readModule): ScenarioEntry {
  return { file, scenario, mobs: huntedMobs(scenario, yamlDir, readDriver) };
}

function yamlFilesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" || full === DRIVER_SOURCE_DIRECTORY ? [] : yamlFilesUnder(full);
    return entry.name.endsWith(".yaml") ? [full] : [];
  });
}

/** Every scenario under `scenarios/` and under the Mine Labs tree of `tests/minecraft` (its scenarios and contract scenarios). */
async function loadEntries(): Promise<ScenarioEntry[]> {
  const repositoryFiles = yamlFilesUnder(SCENARIO_TREE).sort();
  const fromRepository = await Promise.all(
    repositoryFiles.map(async (full) => entryOf(path.relative(REPOSITORY, full).replaceAll("\\", "/"), await loadScenario(full), path.dirname(full))),
  );
  const fromTests = (await loadAllScenarios()).map(({ file, scenario }) =>
    entryOf(`tests/minecraft/${file}`, scenario, path.dirname(path.join(REPOSITORY, "tests", "minecraft", file))),
  );
  return [...fromRepository, ...fromTests];
}

function carriesShield(bot: Bot, player: PlayerSpec): boolean {
  const names = [...player.inventory.map((item) => item.item), ...Object.values(player.equipment ?? {})];
  return names.some((name) => name !== undefined && hasItemFamily(bot, name.replace(/^minecraft:/, ""), SHIELD_FAMILY));
}

function allowsWithoutShield(scenario: Scenario): boolean {
  return [recordOf(scenario.params), recordOf(scenario.params.input)].some((record) => record?.allow_without_shield === true);
}

/** The lines one entry's mob gives: an unknown name, or each player who hunts a hostile mob with no shield. */
function huntLines(entry: ScenarioEntry, mob: string, bot: Bot): string[] {
  if (bot.registry.entitiesByName[mob] === undefined) return [`${entry.file}: unknown mob ${mob}`];
  if (!isHostileSpecies(bot, mob) || allowsWithoutShield(entry.scenario)) return [];
  return entry.scenario.players
    .filter((player) => !carriesShield(bot, player))
    .map((player) => `${entry.file}: ${player.name} hunts ${mob} with no shield`);
}

/** The census: one sorted line per offending hunt, so a list of fixtures reads as one line each. */
function shieldlessHostileHunts(entries: readonly ScenarioEntry[], bot: Bot): string[] {
  return entries.flatMap((entry) => entry.mobs.flatMap((mob) => huntLines(entry, mob, bot))).sort();
}

/** An in-memory scenario, parsed as the Mine Labs runner parses one; its driver module text is `driver`. */
function memoryEntry(input: Record<string, unknown>, driver = ""): ScenarioEntry {
  const scenario = scenarioSchema.parse({
    client: { command: "bun", args: ["../../src/client-host.ts", "./driver.ts"] },
    goal: { kind: "completion" },
    ...input,
  });
  return entryOf("memory.yaml", scenario, "scenarios/flat/hunt", (file: string) => (file.endsWith("driver.ts") ? driver : ""));
}

function registryBot(): Bot {
  return createFakeBot().bot;
}

test("c1: no hostile hunt in the scenario census lacks a shield, and the walk reaches both trees", async () => {
  const bot = registryBot();
  const entries = await loadEntries();
  for (const file of ["scenarios/flat/hunt/blaze-rods.yaml", "tests/minecraft/scenarios/hunt/arrow-hunt-spends-no-arrows.yaml"]) {
    assert.ok(entries.find((entry) => entry.file === file)?.mobs.length, `the walk reaches ${file} and finds a mob in it`);
  }
  assert.deepEqual(shieldlessHostileHunts(entries, bot), [], "hostile hunts with no shield and no allow_without_shield");
});

/** One row per fixture: its label (the assertion message), the entry, and the lines its census gives. */
type CensusRow = [label: string, entry: ScenarioEntry, expected: string[]];

function assertRows(rows: readonly CensusRow[], bot: Bot): void {
  for (const [label, entry, expected] of rows) assert.deepEqual(shieldlessHostileHunts([entry], bot), expected, label);
}

test("c2-c4 and c10: a hostile hunt is named only when no shield is carried in the inventory, the off-hand or params.input's mob", () => {
  assertRows(
    [
      ["c2: an iron sword and no shield", memoryEntry({ players: [{ name: "Hunter", inventory: [{ item: "iron_sword" }] }], params: { mob_name: "zombie" } }), ["memory.yaml: Hunter hunts zombie with no shield"]],
      ["c3: a shield in the inventory", memoryEntry({ players: [{ name: "Hunter", inventory: [{ item: "shield" }] }], params: { mob_name: "zombie" } }), []],
      ["c4: a shield in the off-hand", memoryEntry({ players: [{ name: "Hunter", equipment: { offhand: "shield" } }], params: { mob_name: "zombie" } }), []],
      ["c10: an off-hand shield for params.input's mob", memoryEntry({ players: [{ name: "Hunter", equipment: { offhand: "shield" } }], params: { input: { mob_name: "skeleton" } } }), []],
    ],
    registryBot(),
  );
});

test("c5 and c10: allow_without_shield true in params or params.input exempts a bare hostile hunt, false does not", () => {
  assertRows(
    [
      ["c5: true in params", memoryEntry({ players: [{ name: "Hunter" }], params: { mob_name: "zombie", allow_without_shield: true } }), []],
      ["c5: false in params", memoryEntry({ players: [{ name: "Hunter" }], params: { mob_name: "zombie", allow_without_shield: false } }), ["memory.yaml: Hunter hunts zombie with no shield"]],
      ["c10: true in params.input", memoryEntry({ players: [{ name: "Hunter" }], params: { input: { mob_name: "skeleton", allow_without_shield: true } } }), []],
    ],
    registryBot(),
  );
});

test("c6-c8: a passive mob needs no shield, an unknown mob name is named as unknown, and no mob names no hunt", () => {
  assertRows(
    [
      ["c6: a passive cow", memoryEntry({ players: [{ name: "Hunter" }], params: { mob_name: "cow" } }), []],
      ["c7: a mob the registry does not know", memoryEntry({ players: [{ name: "Hunter" }], params: { mob_name: "no_such_mob" } }), ["memory.yaml: unknown mob no_such_mob"]],
      ["c8: no mob named", memoryEntry({ players: [{ name: "Hunter" }], params: {} }), []],
    ],
    registryBot(),
  );
});

test("c9: a driver module's mob_name literal is a hunt, and a player with no shield is named", () => {
  const entry = memoryEntry(
    { players: [{ name: "Hunter", inventory: [{ item: "iron_sword" }] }] },
    'await runtime.run(hunt, { mob_name: "zombie", drop_name: "rotten_flesh", count: 1 }, signal);',
  );
  assert.deepEqual(entry.mobs, ["zombie"]);
  assert.deepEqual(shieldlessHostileHunts([entry], registryBot()), ["memory.yaml: Hunter hunts zombie with no shield"]);
});

test("c11: two players hunting a zombie, only the first with a shield: the second is named", () => {
  const entry = memoryEntry({
    players: [{ name: "Shielded", inventory: [{ item: "shield" }] }, { name: "Bare", inventory: [{ item: "iron_sword" }] }],
    params: { mob_name: "zombie" },
  });
  assert.deepEqual(shieldlessHostileHunts([entry], registryBot()), ["memory.yaml: Bare hunts zombie with no shield"]);
});
