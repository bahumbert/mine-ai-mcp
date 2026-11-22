// check-reads: scenarios/**/*.yaml
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { goalSchema } from "mine-labs";
import { loadScenarioFiles } from "../shared/scenario-files.ts";
import { loadAllScenarios } from "./all-scenarios.ts";

/** The goal tree the judge reads (mine-labs `goal-schema.ts`): a leaf, or an `all` or `any` of goals. */
interface GoalNode {
  readonly kind: string;
  readonly who?: string;
  readonly max?: number;
  readonly goals?: readonly GoalNode[];
}

/** The part of a loaded scenario the census reads. */
interface GoalOwner {
  readonly goal: GoalNode;
  readonly players: readonly { readonly name: string }[];
}

/** An absence goal is met by nothing happening: a count of zero, or a kill. A death met it before (D21). */
function isAbsenceLeaf(node: GoalNode): boolean {
  return (node.kind === "entityCount" && node.max === 0) || node.kind === "kill";
}

/** The actors a `survive` leaf protects: its `who`, or every declared player when it names none (mine-labs `survive` reads `ctx.players`). */
function survivorsOf(children: readonly GoalNode[], players: readonly string[]): Set<string> {
  return new Set(children.filter((child) => child.kind === "survive").flatMap((child) => (child.who === undefined ? players : [child.who])));
}

/** The actors a `completion` leaf reports on: its `who`, or the first player when it names none (mine-labs `pickPlayer`). */
function completersOf(children: readonly GoalNode[], firstPlayer: string | undefined): Set<string> {
  const actors = children.filter((child) => child.kind === "completion").map((child) => child.who ?? firstPlayer);
  return new Set(actors.filter((actor): actor is string => actor !== undefined));
}

/** The problems of one `all`: every absence leaf names an actor that both survival and completion hold for, or, with no `who`, some actor does. */
function allProblems(children: readonly GoalNode[], players: readonly string[], where: string): string[] {
  const absences = children.filter(isAbsenceLeaf);
  const completed = completersOf(children, players[0]);
  const protectedActors = new Set([...survivorsOf(children, players)].filter((actor) => completed.has(actor)));
  const unprotected = absences.filter((leaf) => (leaf.who === undefined ? protectedActors.size === 0 : !protectedActors.has(leaf.who)));
  if (unprotected.length === 0) return [];
  const names = unprotected.map((leaf) => (leaf.who === undefined ? leaf.kind : `${leaf.kind} of ${leaf.who}`));
  return [`${where}: ${names.join(", ")} is not covered by survive and completion for its actor`];
}

/** The problems of one goal tree: each absence leaf must sit in an `all` that covers it. */
function absenceGoalProblems(node: GoalNode, players: readonly string[], where: string): string[] {
  const children = node.goals ?? [];
  const problems: string[] = [];
  if (node.kind === "all") problems.push(...allProblems(children, players, where));
  if (node.kind === "any") {
    for (const leaf of children.filter(isAbsenceLeaf)) problems.push(`${where}: ${leaf.kind} sits in an any, not in an all`);
  }
  for (const [index, child] of children.entries()) problems.push(...absenceGoalProblems(child, players, `${where}/${index}`));
  return problems;
}

/** Every problem of a scenario's goal, the root included (a bare absence leaf has no `all` around it). */
export function goalProblems(owner: GoalOwner): string[] {
  const players = owner.players.map((player) => player.name);
  const rootProblems = isAbsenceLeaf(owner.goal) ? [`root: ${owner.goal.kind} is alone, with no all for survive and completion`] : [];
  return [...rootProblems, ...absenceGoalProblems(owner.goal, players, "goal")];
}

/** A root goal the Mine Labs schema accepts: the tree plus the timeout a root needs, the leaves carrying their own fields. */
function rootGoal(tree: Record<string, unknown>): GoalNode {
  return goalSchema.parse({ ...tree, timeout: 60 });
}

const SCENARIO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..", "scenarios");
const mineScenarios = await loadAllScenarios();
const rootScenarios = await loadScenarioFiles([SCENARIO_ROOT]);
const everyScenario = [
  ...mineScenarios.map(({ file, scenario }) => ({ file, scenario })),
  ...rootScenarios.scenarios.map(({ id, scenario }) => ({ file: `scenarios/${id}.yaml`, scenario })),
];
/** Whether any leaf of the tree is an absence goal, at any depth. */
function holdsAbsenceLeaf(node: GoalNode): boolean {
  return isAbsenceLeaf(node) || (node.goals ?? []).some(holdsAbsenceLeaf);
}
const absenceFiles = everyScenario.filter(({ scenario }) => holdsAbsenceLeaf(scenario.goal));

const DRAGON = [{ name: "DragonFighter" }];
const TWO = [{ name: "A" }, { name: "B" }];

test("the census reads the legacy scenario tree and the Mine Labs tree, with no load error", () => {
  assert.deepEqual(rootScenarios.errors, []);
  assert.ok(rootScenarios.scenarios.some(({ id }) => id === "default/end/crystals-bow"));
  assert.ok(mineScenarios.length >= 1 && rootScenarios.scenarios.length >= 400, `${mineScenarios.length} and ${rootScenarios.scenarios.length} files`);
});

test("every scenario whose goal holds an entityCount max 0 or a kill also holds survive and completion for its actor in the same all", () => {
  const found = absenceFiles.length;
  assert.ok(found >= 6, `only ${found} scenarios hold an absence goal`);
  const problems = everyScenario.flatMap(({ file, scenario }) => goalProblems(scenario).map((problem) => `${file} ${problem}`));
  assert.deepEqual(problems, []);
});

const ACCEPTED: ReadonlyArray<readonly [string, readonly { readonly name: string }[], GoalNode]> = [
  ["the full shape for one player", DRAGON, rootGoal({ kind: "all", goals: [{ kind: "entityCount", entity: "end_crystal", max: 0 }, { kind: "survive", who: "DragonFighter", seconds: 1 }, { kind: "completion", who: "DragonFighter" }] })],
  ["the dragon-perch form: an unnamed survive and a completion for the first player", DRAGON, rootGoal({ kind: "all", goals: [{ kind: "kill", target: "ender_dragon" }, { kind: "survive", seconds: 1 }, { kind: "completion", who: "DragonFighter" }] })],
  ["two kills of two actors, each with survive and completion", TWO, rootGoal({ kind: "all", goals: [{ kind: "kill", who: "A", target: "zombie" }, { kind: "kill", who: "B", target: "zombie" }, { kind: "survive", seconds: 1 }, { kind: "completion", who: "A" }, { kind: "completion", who: "B" }] })],
  ["an unnamed survive covers every player, a completion for B covers the kill of B", TWO, rootGoal({ kind: "all", goals: [{ kind: "kill", who: "B", target: "zombie" }, { kind: "survive", seconds: 1 }, { kind: "completion", who: "B" }] })],
];

for (const [name, players, goal] of ACCEPTED) {
  test(`accepted: ${name}`, () => {
    assert.deepEqual(goalProblems({ players, goal }), []);
  });
}

const REFUSED: ReadonlyArray<readonly [string, readonly { readonly name: string }[], GoalNode]> = [
  ["a missing survive", DRAGON, rootGoal({ kind: "all", goals: [{ kind: "kill", target: "ender_dragon" }, { kind: "completion", who: "DragonFighter" }] })],
  ["a missing completion", DRAGON, rootGoal({ kind: "all", goals: [{ kind: "kill", target: "ender_dragon" }, { kind: "survive", who: "DragonFighter", seconds: 1 }] })],
  ["a completion for another actor", TWO, rootGoal({ kind: "all", goals: [{ kind: "kill", target: "zombie" }, { kind: "survive", who: "A", seconds: 1 }, { kind: "completion", who: "B" }] })],
  ["a kill of A with survive and completion only for B", TWO, rootGoal({ kind: "all", goals: [{ kind: "kill", who: "A", target: "zombie" }, { kind: "survive", who: "B", seconds: 1 }, { kind: "completion", who: "B" }] })],
  ["one attributed kill of A uncovered beside a kill of B covered", TWO, rootGoal({ kind: "all", goals: [{ kind: "kill", who: "A", target: "zombie" }, { kind: "kill", who: "B", target: "zombie" }, { kind: "survive", who: "B", seconds: 1 }, { kind: "completion", who: "B" }] })],
  ["survive and completion in a sibling any branch", DRAGON, rootGoal({ kind: "all", goals: [{ kind: "kill", target: "ender_dragon" }, { kind: "any", goals: [{ kind: "survive", who: "DragonFighter", seconds: 1 }, { kind: "completion", who: "DragonFighter" }] }] })],
  ["an absence leaf alone at the root", DRAGON, rootGoal({ kind: "entityCount", entity: "end_crystal", max: 0 })],
];

for (const [name, players, goal] of REFUSED) {
  test(`refused: ${name}`, () => {
    assert.ok(goalProblems({ players, goal }).length >= 1, `accepted: ${JSON.stringify(goal)}`);
  });
}
