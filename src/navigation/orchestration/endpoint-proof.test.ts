// The local world, policy and goal premises for a route admission's endpoint proof.
import assert from "node:assert/strict";
import test from "node:test";
import { createFakeBot } from "../../test-support/fake-bot/index.js";
import { observation } from "../../test-support/navigation.js";
import { nearGoal } from "../goals/index.js";
import { blockClass, observeMineflayerBlock } from "../mineflayer/world.js";
import { createMovementPolicy } from "../movements/policy.js";
import { MemoryWorld } from "../world/memory-world.js";
import { samePosition, type BlockPosition } from "../world/world.js";
import { provenEndpoints } from "./endpoint-proof.js";

const at = observation();
const centre = { x: 3, y: 63, z: 0 };
const below = { ...centre, y: 62 };
const endpoints = [
  { ...centre, x: 2 }, below, { ...centre, z: -1 }, centre,
  { ...centre, z: 1 }, { ...centre, y: 64 }, { ...centre, x: 4 },
];
const noEdits = { allowPlacing: false, allowDigging: false };
const { bot } = createFakeBot();
const Block = blockClass(bot);

function near(position = centre, range = 1) {
  const goal = nearGoal(position, range).resolve(at);
  assert.equal(goal.kind, "active");
  return goal;
}

/** Load the registry's actual geometry and traits, including the water level in its block state. */
function load(world: MemoryWorld, position: BlockPosition, name: string, level = 0) {
  const data = bot.registry.blocksByName[name]!;
  const state = name === "water" ? data.minStateId + level : data.defaultState;
  const block = observeMineflayerBlock(Block.fromStateId(state, 0));
  assert.equal(block.kind, "loaded");
  world.load(position, block);
}

/** All range-1 feet and head cells are loaded, with air over grass. */
function eligibleInput(unloaded?: BlockPosition) {
  const world = new MemoryWorld();
  for (let x = 0; x <= 4; x++) for (let z = -1; z <= 1; z++) for (let y = 61; y <= 65; y++) {
    const position = { x, y, z };
    if (!unloaded || !samePosition(position, unloaded)) load(world, position, y === 61 ? "grass_block" : "air");
  }
  load(world, { x: 0, y: 62, z: 0 }, "grass_block");
  return { world, goal: near(), policy: createMovementPolicy(noEdits), observation: at, hasCalculationFallback: false };
}

test("a dry supported no-edit search supplies every loaded endpoint", () => {
  assert.deepEqual(provenEndpoints(eligibleInput()), endpoints);
});

const uncertain: Record<string, (input: ReturnType<typeof eligibleInput>) => Parameters<typeof provenEndpoints>[0]> = {
  "placing allowed": (input) => ({ ...input, policy: createMovementPolicy({ ...noEdits, allowPlacing: true }) }),
  "digging allowed": (input) => ({ ...input, policy: createMovementPolicy({ ...noEdits, allowDigging: true }) }),
  "calculation fallback": (input) => ({ ...input, hasCalculationFallback: true }),
  "swimming stance": (input) => ({ ...input, observation: { ...at, stance: "swimming" } }),
  "wet feet": (input) => { load(input.world, { x: 0, y: 63, z: 0 }, "water"); return input; },
  "wet head": (input) => { load(input.world, { x: 0, y: 64, z: 0 }, "water"); return input; },
  "unloaded start head": () => eligibleInput({ x: 0, y: 64, z: 0 }),
  "goal with finish work": (input) => ({ ...input, goal: { ...input.goal, finish: () => null } }),
  "replaced predicate": (input) => ({ ...input, goal: { ...input.goal, isSatisfied: () => true } }),
  "fractional centre": (input) => ({ ...input, goal: near({ ...centre, x: 3.5 }) }),
  "range 4": (input) => ({ ...input, goal: near(centre, 4) }),
  "unloaded endpoint head": () => eligibleInput({ ...centre, y: 65 }),
  "all endpoints excluded": (input) => {
    for (const endpoint of endpoints) load(input.world, endpoint, "grass_block");
    return input;
  },
};

for (const [premise, alter] of Object.entries(uncertain)) {
  test(`${premise} leaves the search to decide`, () => {
    assert.equal(provenEndpoints(alter(eligibleInput())), null);
  });
}

for (const [label, block, level] of [
  ["door", "oak_door", 0], ["source water", "water", 0], ["flowing water", "water", 1],
  ["slab", "stone_slab", 0],
] as const) {
  test(`an endpoint with ${label} remains a candidate for sight`, () => {
    const input = eligibleInput();
    load(input.world, centre, block, level);
    assert.deepEqual(provenEndpoints(input), endpoints);
  });
}

test("a full-cube floor excludes a feet cell and a full-cube ceiling excludes the cell below", () => {
  const input = eligibleInput();
  load(input.world, below, "grass_block");
  const above = { ...centre, y: 64 };
  load(input.world, { ...above, y: 65 }, "grass_block");
  assert.deepEqual(provenEndpoints(input), endpoints.filter((cell) => !samePosition(cell, below) && !samePosition(cell, above)));
});
