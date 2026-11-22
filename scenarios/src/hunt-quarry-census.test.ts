// check-reads: scenarios/**/*.yaml, scenarios/**/*.ts
/**
 * A hunt whose kill goal names its hunted species needs every declared mob of that species dead, but the shared hunter
 * sends the hunt only `count` (`hunter.ts`): the hunt ends at that many drops, and a fixture declaring more mobs than
 * `count` can end with one alive and fail, as the blaze fixtures did (plan 2026-11-18-scenario-reds-part2-a7 T13t).
 * This census reads every scenario YAML under `scenarios/` and names each such hunt.
 *
 * Limits, said plainly: a mob that drops several items per kill can reach `count` with fewer kills (`count` at least
 * the declared mobs is necessary, not sufficient); no loot data is read; summons in `setup` or `tick` are not counted.
 * It reads data only: no species list.
 */
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { loadScenario, scenarioSchema, type GoalCondition, type Scenario } from "mine-labs";

/** One scenario and its file, from the repository root. */
interface ScenarioEntry {
  readonly file: string;
  readonly scenario: Scenario;
}

const REPOSITORY = path.resolve(import.meta.dirname, "..", "..");
const SCENARIO_TREE = path.join(REPOSITORY, "scenarios");
/** The shared hunter's module, named in a fixture's client args when the fixture runs a hunt. */
const HUNTER_MODULE = "hunter.ts";
const NAMESPACE_PREFIX = /^minecraft:/u;
const HUNTER_ARGS = ["../../src/client-host.ts", "../../src/hunter.ts"];
const DECLARED_POS = [20.5, -60, 0.5];

const bare = (id: string): string => id.replace(NAMESPACE_PREFIX, "");

/** The kill targets a goal tree requires: its root, and the `all` branches under it, never an `any` branch. */
function requiredKillTargets(goal: GoalCondition): string[] {
  if (goal.kind === "kill") return [goal.target];
  if (goal.kind === "all") return goal.goals.flatMap(requiredKillTargets);
  return [];
}

/** One line for the entry when its hunt requires a kill of the hunted species that its `count` cannot satisfy. */
function shortfallLines({ file, scenario }: ScenarioEntry): string[] {
  if (!scenario.client.args.some((arg) => path.basename(arg) === HUNTER_MODULE)) return [];
  const mob = scenario.params.mob_name;
  if (typeof mob !== "string") return [];
  if (!requiredKillTargets(scenario.goal).some((target) => bare(target) === mob)) return [];
  const asked = typeof scenario.params.count === "number" ? scenario.params.count : 1;
  const declared = scenario.entities.filter((entity) => bare(entity.type) === mob).length;
  return declared > asked ? [`${file}: kills ${mob}: ${declared} declared, the hunt asks count ${asked}`] : [];
}

/** The census: one sorted line per hunt whose kill goal needs more defeats than its `count` asks for. */
function huntQuarryShortfalls(entries: readonly ScenarioEntry[]): string[] {
  return entries.flatMap(shortfallLines).sort();
}

/** Every scenario YAML under `scenarios/`, skipping the driver modules (`src/`) and `node_modules/`. */
function yamlFilesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "src" || entry.name === "node_modules" ? [] : yamlFilesUnder(full);
    return entry.name.endsWith(".yaml") ? [full] : [];
  });
}

async function repositoryEntries(): Promise<ScenarioEntry[]> {
  return Promise.all(
    yamlFilesUnder(SCENARIO_TREE).sort().map(async (full) => ({
      file: path.relative(REPOSITORY, full).replaceAll("\\", "/"),
      scenario: await loadScenario(full),
    })),
  );
}

/** An in-memory scenario, parsed as the Mine Labs runner parses one: a hunter client, one player, a completion goal. */
function memoryEntry(input: Record<string, unknown>): ScenarioEntry {
  return {
    file: "memory.yaml",
    scenario: scenarioSchema.parse({
      client: { command: "bun", args: HUNTER_ARGS },
      players: [{ name: "Hunter" }],
      goal: { kind: "completion" },
      ...input,
    }),
  };
}

/** A hunt declaring the `entities` types, requesting `params`, with a root kill goal on blaze unless `goal` says otherwise. */
function hunt(input: { entities: string[]; params: Record<string, unknown>; goal?: unknown; args?: string[] }): ScenarioEntry {
  return memoryEntry({
    client: { command: "bun", args: input.args ?? HUNTER_ARGS },
    entities: input.entities.map((type) => ({ type, pos: DECLARED_POS })),
    goal: input.goal ?? { kind: "kill", target: "blaze" },
    params: input.params,
  });
}

const killOf = (target: string) => ({ kind: "kill", target });
const allOf = (...goals: unknown[]) => ({ kind: "all", goals });
const anyOf = (...goals: unknown[]) => ({ kind: "any", goals });
const NAMED_TWO_BLAZES = "memory.yaml: kills blaze: 2 declared, the hunt asks count 1";

/** One row per fixture: its label (the assertion message), the entry, and the lines its census gives. */
type CensusRow = [label: string, entry: ScenarioEntry, expected: string[]];

function assertRows(rows: readonly CensusRow[]): void {
  for (const [label, entry, expected] of rows) assert.deepEqual(huntQuarryShortfalls([entry]), expected, label);
}

test("c1: the census over the repository names no hunt whose kill goal needs more defeats than it asks, and walks both build-materials fixtures", async () => {
  const entries = await repositoryEntries();
  for (const file of ["scenarios/flat/hunt/blaze-rods.yaml", "scenarios/flat/combat/blaze-build-materials.yaml"]) {
    const entry = entries.find((candidate) => candidate.file === file);
    assert.ok(entry && requiredKillTargets(entry.scenario.goal).length > 0, `the walk reaches ${file} and finds a kill goal in it`);
  }
  assert.deepEqual(huntQuarryShortfalls(entries), [], "kill goal needs more defeats than the hunt asks");
});

test("c2-c3b: two blazes under a kill goal name the hunt when count is 1, whatever defeat_count says, and not when count is 2", () => {
  const pair = ["blaze", "blaze"];
  assertRows([
    ["c2: count 1, defeat_count 1", hunt({ entities: pair, params: { mob_name: "blaze", count: 1, defeat_count: 1 } }), [NAMED_TWO_BLAZES]],
    ["c3: count 1, defeat_count 2 (the hunt still asks one drop)", hunt({ entities: pair, params: { mob_name: "blaze", count: 1, defeat_count: 2 } }), [NAMED_TWO_BLAZES]],
    ["c3b: count 2, defeat_count 1", hunt({ entities: pair, params: { mob_name: "blaze", count: 2, defeat_count: 1 } }), []],
  ]);
});

test("c8, c8b and c9: a hunt is named only when its declared mobs of the hunted species outnumber count, and count defaults to 1", () => {
  assertRows([
    ["c8: one declared blaze and no count", hunt({ entities: ["blaze"], params: { mob_name: "blaze" } }), []],
    ["c8b: two blazes and no count (the hunt asks one drop)", hunt({ entities: ["blaze", "blaze"], params: { mob_name: "blaze" } }), [NAMED_TWO_BLAZES]],
    ["c9: two zombies and one blaze, count 1", hunt({ entities: ["zombie", "zombie", "blaze"], params: { mob_name: "blaze", count: 1 } }), []],
  ]);
});

test("c5: a kill goal inside all inside all names the hunt, and inside any it does not", () => {
  const pair = ["blaze", "blaze"];
  const params = { mob_name: "blaze", count: 1 };
  assertRows([
    ["c5: all inside all", hunt({ entities: pair, params, goal: allOf(allOf(killOf("blaze"), { kind: "completion" })) }), [NAMED_TWO_BLAZES]],
    ["c5: any", hunt({ entities: pair, params, goal: anyOf(killOf("blaze"), { kind: "completion" }) }), []],
  ]);
});

test("c6, c7 and c11: no kill goal, another hunter module, or a kill goal on another species names no hunt", () => {
  const pair = ["blaze", "blaze"];
  assertRows([
    ["c6: no kill goal", hunt({ entities: pair, params: { mob_name: "blaze", count: 1 }, goal: { kind: "completion" } }), []],
    ["c7: client args hold posture-hunter.ts", hunt({ entities: pair, params: { mob_name: "blaze", count: 1 }, args: ["../../src/client-host.ts", "../../src/posture-hunter.ts"] }), []],
    ["c11: kill zombie, the hunt asks for cow", hunt({ entities: ["zombie", "zombie"], params: { mob_name: "cow", count: 1 }, goal: killOf("zombie") }), []],
  ]);
});

test("c10: a minecraft: prefix on the declared type or the kill target is stripped before the species is compared", () => {
  assertRows([
    ["c10: minecraft:blaze declared twice, kill minecraft:blaze", hunt({ entities: ["minecraft:blaze", "minecraft:blaze"], params: { mob_name: "blaze", count: 1 }, goal: killOf("minecraft:blaze") }), [NAMED_TWO_BLAZES]],
  ]);
});
