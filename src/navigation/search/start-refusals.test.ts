import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { type FakeBot, createFakeBot } from "../../test-support/fake-bot/index.js";
import { DIRK_CAVE, DIRK_START, SANA_CAVE, SANA_START, dirkPocket, sanaPocket } from "../../test-support/frozen-pockets.js";
import { WELL_FED, observation, planningStart } from "../../test-support/navigation.js";
import { exactBlockGoal } from "../goals/index.js";
import { createMovementCatalogue } from "../movements/catalogue.js";
import { createMovements } from "../runtime.js";
import type { BlockPosition } from "../world/world.js";
import type { MemoryWorld } from "../world/memory-world.js";
import { IncrementalSearch } from "./search.js";
import { neverLeftStart } from "./start-refusals.js";

/** One search from a pocket's cell to its cave, with the straight-down dig off (the persona's style override) or on. */
function leavePocket(world: (bot: FakeBot) => MemoryWorld, start: BlockPosition, cave: BlockPosition, digDown: boolean) {
  const { bot } = createFakeBot({ position: new Vec3(start.x + 0.5, start.y, start.z + 0.5) });
  const policy = Object.create(createMovements(bot), { allowDownward: { value: digDown } });
  const goal = exactBlockGoal(cave).resolve(observation(start.x, start.y, start.z));
  if (goal.kind !== "active") throw new Error(goal.observation);
  return new IncrementalSearch({
    id: "pocket", start: planningStart(start), goal, now: () => 0,
    context: { world: world(bot), policy, player: WELL_FED, catalogue: createMovementCatalogue() },
  }).advance({ maximumExpansions: 50_000, maximumMilliseconds: 2_000 });
}

test("Dirk's pocket, straight-down dig off: no path, and the refusals at the start are counted by cause", () => {
  const result = leavePocket(dirkPocket, DIRK_START, DIRK_CAVE, false);
  assert.equal(result.kind, "no_path");
  if (result.kind !== "no_path") return;
  const refusals = result.evidence.startRefusals ?? {};
  assert.equal(refusals.policy_dig_down, 1, JSON.stringify(refusals));
  assert.ok((refusals.opens_into_liquid ?? 0) + (refusals.under_water ?? 0) >= 1, JSON.stringify(refusals));
});

test("Dirk's and Sana's searches never left the start cell: one node visited, one generated", () => {
  for (const [world, start, cave] of [[dirkPocket, DIRK_START, DIRK_CAVE], [sanaPocket, SANA_START, SANA_CAVE]] as const) {
    const result = leavePocket(world, start, cave, false);
    assert.equal(result.kind, "no_path");
    if (result.kind !== "no_path") return;
    assert.deepEqual([result.evidence.visited, result.evidence.generated], [1, 1]);
    assert.equal(neverLeftStart(result.evidence), true);
  }
});

test("a search whose every visited node lies within 1 block of the start never left it; one that went 2 away did", () => {
  assert.equal(neverLeftStart({ farthestVisited: 0 }), true);
  assert.equal(neverLeftStart({ farthestVisited: 1 }), true, "Dirk's pocket: his cell and the pillar cell above it");
  assert.equal(neverLeftStart({ farthestVisited: 2 }), false);
  assert.equal(neverLeftStart({ farthestVisited: 9 }), false);
});

test("Dirk's pocket, straight-down dig on: the route digs down and arrives", () => {
  assert.equal(leavePocket(dirkPocket, DIRK_START, DIRK_CAVE, true).kind, "complete");
});

test("Sana's pocket: the dig below her opens into the water beside her cell, so the flood rule is named, not the style override", () => {
  for (const digDown of [false, true]) {
    const result = leavePocket(sanaPocket, SANA_START, SANA_CAVE, digDown);
    assert.equal(result.kind, "no_path");
    if (result.kind !== "no_path") return;
    const refusals = result.evidence.startRefusals ?? {};
    assert.ok((refusals.opens_into_liquid ?? 0) >= 1, JSON.stringify(refusals));
    assert.equal(refusals.policy_dig_down, undefined, JSON.stringify(refusals));
  }
});
