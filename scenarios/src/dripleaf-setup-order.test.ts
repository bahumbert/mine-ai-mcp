// check-reads: scenarios/**/*.yaml, tests/minecraft/scenarios/**/*.yaml, tests/minecraft/contract/scenarios/**/*.yaml
/**
 * A big dripleaf stem needs a leaf or a stem directly above it when it is placed: a stem with air above it is destroyed
 * by the next game tick, and Mine Labs runs a scenario's setup one rcon command at a time, so a tick can fall between
 * two of them. This census compiles every scenario and refuses a stem placed before the block above it (plan
 * 2026-11-18-scenario-reds-part2-a12 T13ad; evidence `.agent/reports/2026-11-22-dripleaf-pinned-stem-analysis.md`).
 * The support rule is measured for the leaf case (the forced-gap trace); the stem-on-stem reading is unverified in vanilla.
 * Known gap, not checked: a block write the census does not read (`clone`, a relative `setblock`) does not clear the
 * record of the cell it writes, so a stem placed after one may pass. A fill it cannot read is reported, not passed over.
 */
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { compileScenario, loadScenario, type Scenario } from "mine-labs";
import { loadAllScenarios } from "../../tests/minecraft/arena/all-scenarios.ts";

const REPOSITORY = path.resolve(import.meta.dirname, "..", "..");
const SCENARIO_TREE = path.join(REPOSITORY, "scenarios");
const STEM = "big_dripleaf_stem";
const LEAF = "big_dripleaf";
const SUPPORTS_STEM: ReadonlySet<string> = new Set([LEAF, STEM]);
/** `setblock x y z [minecraft:]block`: the block name without its state, so the stem and the leaf are told apart. */
const SETBLOCK = /\bsetblock\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(?:minecraft:)?([a-z_]+)/;
/** `fill x1 y1 z1 x2 y2 z2 [minecraft:]block[state]` and nothing after it: a literal box. A mode (replace, hollow...) or a relative coordinate is not matched, and is reported as not read. */
const FILL = /\bfill\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(?:minecraft:)?([a-z_]+)(?:\[[^\]]*\])?\s*$/;

function keyOf(x: number, y: number, z: number): string {
  return `${x} ${y} ${z}`;
}

/**
 * Each setup command that places a stem with nothing above it yet, and each command the census cannot read.
 * `written` holds the block last written at each cell by the commands before, from the setblock and literal fill forms.
 */
function stemOrderViolations(setup: readonly string[]): string[] {
  const written = new Map<string, string>();
  const violations: string[] = [];
  setup.forEach((command, index) => {
    const placed = SETBLOCK.exec(command);
    if (command.includes(STEM)) {
      if (placed?.[4] !== STEM) {
        violations.push(`setup command ${index}: not read: extend this census`);
        return;
      }
      const [x, y, z] = placed.slice(1, 4).map(Number) as [number, number, number];
      if (!SUPPORTS_STEM.has(written.get(keyOf(x, y + 1, z)) ?? "")) {
        violations.push(`setup command ${index}: ${command} (no big_dripleaf or big_dripleaf_stem above it yet)`);
      }
      written.set(keyOf(x, y, z), STEM);
      return;
    }
    if (placed) {
      const [x, y, z] = placed.slice(1, 4).map(Number) as [number, number, number];
      written.set(keyOf(x, y, z), placed[4]!);
      return;
    }
    const box = FILL.exec(command);
    if (!box) {
      if (/\bfill\b/.test(command)) violations.push(`setup command ${index}: not read: extend this census`);
      return;
    }
    const [x1, y1, z1, x2, y2, z2] = box.slice(1, 7).map(Number) as [number, number, number, number, number, number];
    for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++)
      for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++)
        for (let z = Math.min(z1, z2); z <= Math.max(z1, z2); z++) written.set(keyOf(x, y, z), box[7]!);
  });
  return violations;
}

/** The indexes of the violating commands, so a test names the command it expects. */
function violatingIndexes(setup: readonly string[]): number[] {
  return stemOrderViolations(setup).map((line) => Number(/^setup command (\d+):/.exec(line)?.[1]));
}

const LEAF_AT_0_59 = "setblock 0 -59 0 big_dripleaf[facing=east,tilt=none,waterlogged=false]";
const STEM_AT_0_60 = "setblock 0 -60 0 big_dripleaf_stem[facing=east,waterlogged=true]";

test("a stem placed before its leaf is a violation, and the other order is not", () => {
  assert.deepEqual(violatingIndexes([STEM_AT_0_60, LEAF_AT_0_59]), [0]);
  assert.deepEqual(violatingIndexes([LEAF_AT_0_59, STEM_AT_0_60]), []);
});

test("a column of stems under one leaf passes in leaf-first order and fails in stem-first order", () => {
  const leaf = (y: number): string => `setblock 0 ${y} 0 big_dripleaf[facing=east,tilt=none,waterlogged=false]`;
  const stem = (y: number): string => `setblock 0 ${y} 0 big_dripleaf_stem[facing=east,waterlogged=true]`;
  assert.deepEqual(violatingIndexes([leaf(-57), stem(-58), stem(-59)]), []);
  assert.deepEqual(violatingIndexes([stem(-59), stem(-58), leaf(-57)]), [0, 1]);
  assert.deepEqual(violatingIndexes([stem(-58), stem(-59), leaf(-57)]), [0]);
});

test("a support at another cell does not count, above or below", () => {
  assert.deepEqual(violatingIndexes(["setblock 1 -59 0 big_dripleaf[facing=east,tilt=none,waterlogged=false]", STEM_AT_0_60]), [1]);
  assert.deepEqual(violatingIndexes(["setblock 0 -61 0 big_dripleaf[facing=east,tilt=none,waterlogged=false]", STEM_AT_0_60]), [1]);
  assert.deepEqual(violatingIndexes(["setblock 0 -59 1 big_dripleaf[facing=east,tilt=none,waterlogged=false]", STEM_AT_0_60]), [1]);
});

test("a cleared or replaced support does not count, and a dripleaf block written over the cell does", () => {
  assert.deepEqual(violatingIndexes([LEAF_AT_0_59, "fill 0 -59 0 0 -59 0 air", STEM_AT_0_60]), [2]);
  assert.deepEqual(violatingIndexes([LEAF_AT_0_59, "setblock 0 -59 0 air", STEM_AT_0_60]), [2]);
  assert.deepEqual(violatingIndexes([LEAF_AT_0_59, "fill 0 -62 0 0 -50 0 big_dripleaf", STEM_AT_0_60]), []);
  assert.deepEqual(violatingIndexes([LEAF_AT_0_59, "fill 0 -62 0 0 -60 0 air", STEM_AT_0_60]), []);
  assert.deepEqual(violatingIndexes([LEAF_AT_0_59, "fill 0 -50 0 0 -59 0 air", STEM_AT_0_60]), [2]);
});

test("the execute prefix and the minecraft: namespace are read", () => {
  assert.deepEqual(
    violatingIndexes([
      "execute in minecraft:overworld run setblock 0 -59 0 minecraft:big_dripleaf[facing=east,tilt=none,waterlogged=false]",
      "execute in minecraft:overworld run setblock 0 -60 0 minecraft:big_dripleaf_stem[facing=east,waterlogged=true]",
    ]),
    [],
  );
});

test("a form the census cannot read is reported, a stem written by a fill included", () => {
  assert.deepEqual(violatingIndexes(["fill 0 -60 0 0 -58 0 big_dripleaf_stem"]), [0]);
  assert.deepEqual(violatingIndexes(["execute positioned 0 -60 0 run setblock ~ ~ ~ big_dripleaf_stem"]), [0]);
  assert.deepEqual(violatingIndexes(["fill 0 -62 0 0 -50 0 air replace big_dripleaf_stem"]), [0]);
  assert.deepEqual(violatingIndexes([LEAF_AT_0_59, "fill 0 -62 0 0 -50 0 stone replace air", STEM_AT_0_60]), [1]);
});

/** Every scenario under `scenarios/` (the drivers' tree skipped) and under the Mine Labs tree of `tests/minecraft`. */
async function loadScenarios(): Promise<Array<{ file: string; scenario: Scenario }>> {
  const repositoryFiles = scenarioYamlFiles().sort();
  const fromRepository = await Promise.all(
    repositoryFiles.map(async (full) => ({ file: path.relative(REPOSITORY, full).replaceAll("\\", "/"), scenario: await loadScenario(full) })),
  );
  const fromTests = (await loadAllScenarios()).map(({ file, scenario }) => ({ file: `tests/minecraft/${file}`, scenario }));
  return [...fromRepository, ...fromTests];
}

/** The scenario YAMLs under the tree; the drivers' folder `src/` and any `node_modules` are left out. */
function scenarioYamlFiles(): string[] {
  return readdirSync(SCENARIO_TREE, { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(".yaml") && entry.split(path.sep)[0] !== "src" && !entry.split(path.sep).includes("node_modules"))
    .map((entry) => path.join(SCENARIO_TREE, entry));
}

test("no compiled scenario places a stem before the block above it, and the census does see stems", async () => {
  const scenarios = await loadScenarios();
  const named = scenarios.filter(({ scenario }) => compileScenario(scenario).setup.some((command) => command.includes(STEM)));
  assert.ok(named.length >= 2, `the census saw ${named.length} scenarios that place a ${STEM}, expected at least 2`);
  const violations = scenarios.flatMap(({ file, scenario }) => stemOrderViolations(compileScenario(scenario).setup).map((line) => `${file}: ${line}`));
  assert.deepEqual(violations.sort(), [], "stems placed before the block above them, by repository path");
});
