import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot } from "../../../test-support/fake-bot/index.js";
import { WELL_FED, observation, planningStart } from "../../../test-support/navigation.js";
import { DIG_REACH } from "../../movements/excavation.js";
import { blockClass, observeMineflayerBlock } from "../../mineflayer/world.js";
import { createMovementCatalogue } from "../../movements/catalogue.js";
import { createMovements } from "../../runtime.js";
import { IncrementalSearch } from "../../search/search.js";
import { MemoryWorld } from "../../world/memory-world.js";
import { STANDING_EYE_HEIGHT, visibleBlockAim } from "../../../world/block-visibility.js";
import type { Goal } from "../../goals/goal.js";
import { asVec3 } from "../../../utils/index.js";
import { build, type BuildCell } from "./build-process.js";

/**
 * Live 2026-10-10 run 8: a runtime went silent for 5 s while a build was levelling a 9x9 site (81 cells asked to be
 * air) from a swim cell in shallow water, under a goal of 38 "visible-dig" targets. Count the goal's block reads and
 * visibility raycasts to catch repeated work independent of machine load.
 */
const SITE = { x0: 2737, x1: 2745, z0: -380, z1: -372, y: 62 };
const AREA = { x0: 2728, x1: 2756, z0: -392, z1: -362 };
const FEET = { x: 2743, y: 61, z: -375 };
// The 3x3x3 neighbourhood has 26 other cells; visibility can try six faces per cell.
// Measured 2026-11-10: at most 8 reads and 8 rays across the four starting positions.
const NEIGHBOURS_PER_CELL = 26;
const FACES_PER_NEIGHBOUR = 6;

/** Stone floor at y 60, water at y 61-62 over all of it (one-deep around the bot), air above. */
function cellName(x: number, y: number, z: number): string {
  if (y <= 60) return "stone";
  if (y <= 62) return "water";
  return "air";
}

function fixture() {
  const names: Record<string, string> = {};
  for (let x = AREA.x0; x <= AREA.x1; x++)
    for (let z = AREA.z0; z <= AREA.z1; z++)
      for (let y = 58; y <= 66; y++) names[`${x},${y},${z}`] = cellName(x, y, z);
  const { bot } = createFakeBot({ position: new Vec3(FEET.x + 0.5, FEET.y, FEET.z + 0.5), cells: names });
  const { registry } = bot;
  const world = new MemoryWorld();
  const Block = blockClass(bot);
  for (const [key, name] of Object.entries(names)) {
    const [x, y, z] = key.split(",").map(Number) as [number, number, number];
    const block = observeMineflayerBlock(Block.fromStateId(registry.blocksByName[name]!.defaultState, 0));
    if (block.kind !== "loaded") throw new Error(name);
    world.load({ x, y, z }, { stateId: block.stateId, collisionShapes: block.collisionShapes, traits: block.traits });
  }
  const cells: BuildCell[] = [];
  for (let x = SITE.x0; x <= SITE.x1; x++) for (let z = SITE.z0; z <= SITE.z1; z++) cells.push({ position: { x, y: SITE.y, z }, blockName: "air" });
  return { bot, world, cells };
}

/** The goal the build hands its route, captured from the first leg. */
async function capturedGoal(bot: ReturnType<typeof fixture>["bot"], cells: BuildCell[]): Promise<Goal> {
  let goal: Goal | null = null;
  await build(bot, {
    movements: () => ({}) as never,
    route: async (options) => {
      goal ??= options.goal;
      return { status: "completed", elapsedMs: 0 };
    },
    breakInPlace: async () => ({ status: "refused", reason: "no" }) as never,
    place: async () => ({ kind: "refused" }) as never,
    canSeeDig: (target, standing) => {
      const block = bot.blockAt(asVec3(target));
      if (block === null) return false;
      const eye = { x: standing.x, y: standing.y + STANDING_EYE_HEIGHT, z: standing.z };
      return visibleBlockAim(bot.world, eye, target, DIG_REACH, observeMineflayerBlock(block as never).collisionShapes) !== null;
    },
    cells,
    removeWrongBlocks: false,
  });
  if (goal === null) throw new Error("the build never routed");
  return goal;
}

for (const away of [0, 8, 16, 24]) {
  test(`the levelling goal from a swim cell ${away} blocks east of the site bounds world reads`, async () => {
    const { bot, world, cells } = fixture();
    const goal = await capturedGoal(bot, cells);
    let reads = 0;
    let rays = 0;
    const blockAt = bot.blockAt.bind(bot);
    const raycast = bot.world.raycast.bind(bot.world);
    bot.blockAt = (...args) => { reads++; return blockAt(...args); };
    bot.world.raycast = (...args) => { rays++; return raycast(...args); };
    const feet = { x: FEET.x + away, y: FEET.y, z: FEET.z };
    bot.entity.position = new Vec3(feet.x + 0.5, feet.y, feet.z + 0.5);
    const resolved = goal.resolve(observation(feet.x, feet.y, feet.z));
    assert.equal(resolved.kind, "active", JSON.stringify(resolved).slice(0, 300));
    if (resolved.kind !== "active") return;
    const state = planningStart(feet, 0);
    const view = state.overlay.view(world);
    resolved.isSatisfied(state.node, view);
    resolved.heuristic(state.node);
    const search = new IncrementalSearch({
      id: "level", start: state, goal: resolved, now: () => 0,
      context: { world, policy: createMovements(bot), player: WELL_FED, catalogue: createMovementCatalogue() },
    });
    for (let slice = 0; slice < 5; slice++) {
      const update = search.advance({ maximumExpansions: 5 });
      if (update.kind !== "progress") break;
    }
    assert.ok(reads <= cells.length * NEIGHBOURS_PER_CELL, `block reads: ${reads}`);
    assert.ok(rays <= cells.length * NEIGHBOURS_PER_CELL * FACES_PER_NEIGHBOUR, `raycasts: ${rays}`);
  });
}
