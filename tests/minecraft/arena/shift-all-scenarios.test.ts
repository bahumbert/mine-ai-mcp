import assert from "node:assert/strict";
import test from "node:test";
import { compileScenario, scenarioSchema, type Scenario } from "mine-labs";
import { splitCommand } from "./command-tokens.ts";
import { loadAllScenarios } from "./all-scenarios.ts";
import { FRESH_SERVER_GAMERULES } from "./gamerule-defaults.ts";
import { laneOf } from "./lanes.ts";
import { settingsOf } from "./settings.ts";
import { shiftScenario } from "./shift-scenario.ts";

const LANE = laneOf(3);
const Z = LANE.offset.z;
const BOX = `x=${LANE.cell.minX},y=-64,z=${LANE.cell.minZ},dx=${LANE.cell.maxX - LANE.cell.minX},dy=383,dz=${LANE.cell.maxZ - LANE.cell.minZ}`;

/** Files the shift refuses today, each with the reason the scenario gets a server of its own. */
const REFUSED: ReadonlyMap<string, RegExp> = new Map([
  // Natural terrain at a fixed place (seeded default world): lanes are flat.
  ["scenarios/collect/cast-obsidian.yaml", /world\.type/u],
  ["scenarios/pathfinder/obsidian-lava-approach.yaml", /world\.type/u],
  // Contract checks whose subject changes a server-wide setting while they run (the mobGriefing rule, the weather).
  ["contract/scenarios/explosion-knockback.yaml", /exclusive/u],
  ["contract/scenarios/deflect-fireball.yaml", /exclusive/u],
  ["contract/scenarios/projectile-hit-bot.yaml", /exclusive/u],
  ["contract/scenarios/item-pickup-after-delay.yaml", /exclusive/u],
  ["contract/scenarios/rain-and-thunder-state.yaml", /exclusive/u],
  // A contract check that measures server ticks from the wall clock: another lane's clone would stall the server thread under it.
  ["contract/scenarios/bow-draw-and-release.yaml", /exclusive/u],
  // A contract check that sets the server's tick rate while it runs.
  ["contract/scenarios/world-age-at-slow-tick.yaml", /exclusive/u],
  // The arena and its scratch copy pin more than the 256 chunks Minecraft force-loads.
  ["scenarios/collect/obsidian-by-exploring.yaml", /chunks/u],
  ["scenarios/pathfinder/at-sea-land-behind-kelp.yaml", /chunks/u],
]);

const all = await loadAllScenarios();

test("the census reads the scenarios of both directories", () => {
  assert.ok(all.length >= 91, `only ${all.length} scenario files found`);
  assert.ok(all.some(({ file }) => file.startsWith("contract/scenarios/")));
  assert.ok(all.some(({ file }) => file.startsWith("scenarios/")));
});

test("exactly the listed scenarios are refused, each for its listed reason", () => {
  const refused = new Map<string, string>();
  for (const { file, scenario } of all) {
    const result = shiftScenario(settingsOf(scenario, FRESH_SERVER_GAMERULES).scenario, LANE);
    if (!result.ok) refused.set(file, result.reason);
  }
  assert.deepEqual([...refused.keys()].sort(), [...REFUSED.keys()].sort());
  for (const [file, reason] of refused) assert.match(reason, REFUSED.get(file)!, file);
});

/** Letters, digits and underscores, or one number, or one other character: a command as atoms, so only numbers and names can differ. */
const ATOM = /-?\d+(?:\.\d+)?|[A-Za-z_][\w:]*|./gu;

/** The shifted command with the lane's box and renames taken back out. */
function unshiftedForm(command: string, renames: ReadonlyMap<string, string>): string {
  let plain = command.replaceAll(`,${BOX}`, "").replaceAll(`${BOX},`, "").replaceAll(BOX, "").replaceAll("[]", "");
  for (const [original, renamed] of renames) plain = plain.replace(new RegExp(`\\b${renamed}\\b`, "gu"), original);
  return plain;
}

/** Same atoms; a number may differ by exactly the lane offset on z (the offset on x is 0). Returns the problem found, or how many numbers moved. */
function sameButMoved(original: string, moved: string): { readonly problem: string } | { readonly moved: number } {
  const before = original.match(ATOM) ?? [];
  const after = moved.match(ATOM) ?? [];
  if (before.length !== after.length) return { problem: `atom count ${before.length} vs ${after.length}` };
  let count = 0;
  for (const [index, atom] of before.entries()) {
    const other = after[index]!;
    const numeric = /^-?\d/u.test(atom) && /^-?\d/u.test(other);
    if (atom === other) continue;
    if (!numeric || Math.abs(Number(other) - Number(atom) - Z) > 1e-9) return { problem: `'${atom}' became '${other}'` };
    count++;
  }
  return { moved: count };
}

/** Index of the z word of each position triple, by verb: a small table apart from the code under test. */
const Z_WORDS: Readonly<Record<string, readonly number[]>> = { fill: [3, 6], setblock: [3], clone: [3, 6, 9], summon: [4] };

/**
 * How many z numbers of this original command the shift must have moved, counted apart from the code under test:
 * selector `z=` arguments, `execute positioned`, `if|unless block|blocks` and `item ... block` positions, and the z words of the command
 * after the last `run`. A command in a scenario that this count does not know (tp, forceload...) fails the census with
 * a count mismatch: extend this function with the new construct.
 */
function zNumbersToMove(command: string): number {
  const selectorArguments = (command.match(/\bz=-?[\d.]+/gu) ?? []).length;
  const positioned = (command.match(/\bpositioned (?!as\b)/gu) ?? []).length;
  const blockConditions = (command.match(/\b(?:if|unless) block\b/gu) ?? []).length + 3 * (command.match(/\b(?:if|unless) blocks\b/gu) ?? []).length;
  const words = splitCommand(command.split(/\brun\b/u).at(-1)!.trim());
  const itemBlocks = (command.match(/\bitem (?:replace|modify) block\b/gu) ?? []).length + (command.match(/\bfrom block\b/gu) ?? []).length;
  return selectorArguments + positioned + blockConditions + itemBlocks + (Z_WORDS[words[0] ?? ""]?.length ?? 0);
}

function renamesIn(original: Scenario, shifted: Scenario): Map<string, string> {
  return new Map(original.players.map((player, index) => [player.name, shifted.players[index]!.name]));
}

for (const { file, scenario } of all) {
  if (REFUSED.has(file)) continue;
  test(`${file} shifts to lane 3 with its commands, region and pins moved by exactly the offset`, () => {
    const lifted = settingsOf(scenario, FRESH_SERVER_GAMERULES).scenario;
    const result = shiftScenario(lifted, LANE);
    assert.ok(result.ok, result.ok ? "" : result.reason);
    const shifted = result.scenario;
    assert.ok(scenarioSchema.safeParse(shifted).success, "the shifted scenario is no longer a valid scenario");

    const before = compileScenario(lifted);
    const after = compileScenario(shifted);
    const renames = renamesIn(lifted, shifted);
    // `tick` is not compiled into commands (Mine Labs writes it to a datapack), so it is compared as it stands.
    const lists = { setup: [before.setup, after.setup], activation: [before.activation, after.activation], teardown: [before.teardown, after.teardown], tick: [lifted.tick, shifted.tick] } as const;
    for (const [list, [originals, shiftedCommands]] of Object.entries(lists)) {
      assert.equal(shiftedCommands.length, originals.length, `${list} length`);
      for (const [index, command] of shiftedCommands.entries()) {
        const original = originals[index]!;
        const result = sameButMoved(original, unshiftedForm(command, renames));
        assert.ok("moved" in result, `${list}[${index}] '${original}' -> '${command}': ${"problem" in result ? result.problem : ""}`);
        assert.equal(result.moved, zNumbersToMove(original), `${list}[${index}] '${original}' -> '${command}': z numbers moved`);
      }
    }

    assert.deepEqual(after.region && { ...after.region, minZ: after.region.minZ - Z, maxZ: after.region.maxZ - Z }, before.region);
    for (const region of after.snapshot?.pin ?? []) {
      assert.ok(region.minX >= LANE.cell.minX && region.maxX <= LANE.cell.maxX, `pin x ${region.minX}..${region.maxX} leaves the cell`);
      assert.ok(region.minZ >= LANE.cell.minZ && region.maxZ <= LANE.cell.maxZ, `pin z ${region.minZ}..${region.maxZ} leaves the cell`);
    }
  });
}
