import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { type FakeBot, createFakeBot } from "../../test-support/fake-bot/index.js";
import { loadNamedBlock } from "../../test-support/layered-world.js";
import { DIRK_CAVE, DIRK_START, SANA_CAVE, SANA_START, dirkPocket, sanaPocket } from "../../test-support/frozen-pockets.js";
import { WELL_FED, flatWorld, observation, planningStart } from "../../test-support/navigation.js";
import { exactBlockGoal } from "../goals/index.js";
import { createMovementCatalogue } from "../movements/catalogue.js";
import { LAVA_SPREAD_REASON } from "../movements/policy.js";
import { createMovements } from "../runtime.js";
import type { BlockPosition } from "../world/world.js";
import { MemoryWorld } from "../world/memory-world.js";
import { IncrementalSearch } from "./search.js";
import { countStartRefusals, neverLeftStart } from "./start-refusals.js";

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

// ── Lava about to flow into the side cells (plan p4-06b T7, spec D5) ─────────────────────────────────────────────
// The floor of `flatWorld` is y 62, the feet cell y 63. Lava is a source: in the overworld it spreads one more step.
const LAVA_FEET = { x: 0, y: 63, z: 0 } as const;

/** The start refusals of `world` for a bot at {@link LAVA_FEET}; `edit` builds on the flat world with the bot's registry. */
function startRefusalsBeside(edit: (world: MemoryWorld, bot: FakeBot) => void) {
  const { bot } = createFakeBot();
  const world = flatWorld();
  edit(world, bot);
  return countStartRefusals(world, createMovements(bot), LAVA_FEET);
}

test("a passable side neighbour whose step the policy refuses for lava spread counts under that reason, level, one up and one down", () => {
  const cases = [
    ["side cell", (world: MemoryWorld, bot: FakeBot) => loadNamedBlock(world, bot, { x: 2, y: 63, z: 0 }, "lava")],
    // The lava stands on a floor: the settled stream beside a step (a head-height lava over an open cell would also refuse the level cell, next test).
    ["step-up cell, lava on its feet row", (world: MemoryWorld, bot: FakeBot) => {
      world.load({ x: 2, y: 63, z: 0 }, { stateId: 1 });
      loadNamedBlock(world, bot, { x: 2, y: 64, z: 0 }, "lava");
    }],
    ["step-down cell, the floor dug out", (world: MemoryWorld, bot: FakeBot) => {
      world.load({ x: 1, y: 62, z: 0 }, { stateId: 0 });
      loadNamedBlock(world, bot, { x: 2, y: 62, z: 0 }, "lava");
    }],
  ] as const;
  for (const [name, edit] of cases) assert.equal(startRefusalsBeside(edit)[LAVA_SPREAD_REASON], 1, name);
});

test("lava over an open cell beside the head of a side cell refuses that cell too, as the step-up cell under it (T3a, contract check lava-beside-head)", () => {
  const refusals = startRefusalsBeside((world, bot) => loadNamedBlock(world, bot, { x: 2, y: 64, z: 0 }, "lava"));
  assert.equal(refusals[LAVA_SPREAD_REASON], 2, "the level cell (lava beside its head, over air) and the step-up cell (lava on its feet row)");
});

test("a side cell with no lava, or a solid one (judged by the dig rules, not as a step), counts no lava refusal", () => {
  assert.equal(startRefusalsBeside(() => {})[LAVA_SPREAD_REASON], undefined);
  const walled = startRefusalsBeside((world, bot) => {
    for (const y of [63, 64]) loadNamedBlock(world, bot, { x: 1, y, z: 0 }, "stone");
    loadNamedBlock(world, bot, { x: 2, y: 63, z: 0 }, "lava");
  });
  assert.equal(walled[LAVA_SPREAD_REASON], undefined);
});

test("an unloaded side cell is never asked for a step", () => {
  const { bot } = createFakeBot();
  const world = new MemoryWorld();
  for (let x = -2; x <= 2; x += 1) for (let z = -2; z <= 2; z += 1) {
    if (x === 1 && z === 0) continue; // the cell east of the bot at feet height and above stays unloaded
    for (const y of [62, 63, 64, 65]) world.load({ x, y, z }, { stateId: y === 62 ? 1 : 0 });
  }
  assert.equal(countStartRefusals(world, createMovements(bot), LAVA_FEET)[LAVA_SPREAD_REASON], undefined);
});

test("fire in the side cells is no lava exit: the policy avoids it, but no refusal is counted for it", () => {
  const refusals = startRefusalsBeside((world, bot) => {
    for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) loadNamedBlock(world, bot, { x, y: 63, z }, "fire");
  });
  assert.deepEqual(refusals, {});
});
