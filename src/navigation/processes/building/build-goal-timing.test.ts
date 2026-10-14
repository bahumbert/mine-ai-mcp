import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { botFixture, registry } from "../../../test-support/bot.js";
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
 * air) from a swim cell in shallow water, under a goal of 38 "visible-dig" targets. These time that goal's calls: a
 * goal check has to stay far under a search slice (8 ms of nodes).
 */
const SITE = { x0: 2737, x1: 2745, z0: -380, z1: -372, y: 62 };
const AREA = { x0: 2728, x1: 2756, z0: -392, z1: -362 };
const FEET = { x: 2743, y: 61, z: -375 };

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
  const bot = botFixture({ position: new Vec3(FEET.x + 0.5, FEET.y, FEET.z + 0.5), blocks: names });
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

function milliseconds<T>(work: () => T): [T, number] {
  const began = performance.now();
  const result = work();
  return [result, performance.now() - began];
}

for (const away of [0, 8, 16, 24]) {
  test(`the levelling goal from a swim cell ${away} blocks east of the site: each call and one search slice stay far under 50 ms`, async () => {
    const { bot, world, cells } = fixture();
    const goal = await capturedGoal(bot, cells);
    const feet = { x: FEET.x + away, y: FEET.y, z: FEET.z };
    bot.entity.position = new Vec3(feet.x + 0.5, feet.y, feet.z + 0.5);
    const [resolved, resolveMs] = milliseconds(() => goal.resolve(observation(feet.x, feet.y, feet.z)));
    assert.equal(resolved.kind, "active", JSON.stringify(resolved).slice(0, 300));
    if (resolved.kind !== "active") return;
    const state = planningStart(feet, 0);
    const view = state.overlay.view(world);
    const [, satisfiedMs] = milliseconds(() => resolved.isSatisfied(state.node, view));
    const [, heuristicMs] = milliseconds(() => resolved.heuristic(state.node));
    const search = new IncrementalSearch({
      id: "level", start: state, goal: resolved, now: () => performance.now(),
      context: { world, policy: createMovements(bot), player: WELL_FED, catalogue: createMovementCatalogue() },
    });
    const slices: number[] = [];
    let last = "";
    for (let slice = 0; slice < 5; slice++) {
      const [update, ms] = milliseconds(() => search.advance({ maximumMilliseconds: 8 }));
      slices.push(ms);
      last = update.kind;
      if (update.kind !== "progress") break;
    }
    console.log(`goal timing, ${away} away (ms): resolve ${resolveMs.toFixed(2)}, isSatisfied ${satisfiedMs.toFixed(2)}, heuristic ${heuristicMs.toFixed(2)}, slices ${slices.map((ms) => ms.toFixed(1)).join("/")} (${last}), ${resolved.revision.split("|").length} targets`);
    for (const [name, ms] of Object.entries({ resolveMs, satisfiedMs, heuristicMs, slowestSlice: Math.max(...slices) })) assert.ok(ms < 50, `${name} took ${ms.toFixed(1)} ms`);
  });
}
