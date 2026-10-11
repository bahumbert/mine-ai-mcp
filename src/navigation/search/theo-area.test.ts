import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Vec3 } from "vec3";
import { WELL_FED, observation, planningStart } from "../../test-support/navigation.js";
import { setProtectedRegionsProvider, type ProtectedRegion } from "../../world/protected-regions.js";
import { customGoal, exactBlockGoal } from "../goals/index.js";
import { createMovementCatalogue } from "../movements/catalogue.js";
import { createMovements } from "../runtime.js";
import { IncrementalSearch } from "./search.js";
import { botFixture, registry } from "../../test-support/bot.js";
import { blockClass, observeMineflayerBlock } from "../mineflayer/world.js";
import { MemoryWorld } from "../world/memory-world.js";

interface Dump { x0: number; layers: { y: number; rows: { z: number; blocks: string }[] }[] }

/** Theo's 3x3 house on 2026-10-11 (improve test), read from the saved world: x 2286-2318, y 64-78, z 480-510. */
function theoArea(bot: ReturnType<typeof theoBot>): MemoryWorld {
  const dump: Dump = JSON.parse(readFileSync(new URL("./fixtures/theo-area.json", import.meta.url), "utf8"));
  const world = new MemoryWorld();
  const Block = blockClass(bot);
  for (const layer of dump.layers)
    for (const row of layer.rows)
      row.blocks.split(" ").forEach((cell, i) => {
        const [name, properties] = cell.split("@") as [string, string | undefined];
        const state = properties === undefined
          ? Block.fromStateId(registry.blocksByName[name]!.defaultState, 0)
          : Block.fromProperties(registry.blocksByName[name]!.id, Object.fromEntries(properties.split(",").map((pair) => {
              const [key, value] = pair.split("=") as [string, string];
              return [key, value === "true" ? true : value === "false" ? false : /^\d+$/.test(value) ? Number(value) : value];
            })) as never, 0);
        const block = observeMineflayerBlock(state);
        if (block.kind !== "loaded") throw new Error(name);
        world.load({ x: dump.x0 + i, y: layer.y, z: row.z }, { stateId: block.stateId, collisionShapes: block.collisionShapes, traits: block.traits });
      });
  return world;
}

const REGIONS: readonly ProtectedRegion[] = [
  { regionId: 1, dimension: "overworld", min: { x: 2307, y: 68, z: 496 }, max: { x: 2315, y: 75, z: 504 }, owner: "Theo", label: "small medieval house" },
  { regionId: 2, dimension: "overworld", min: { x: 2303, y: 62, z: 492 }, max: { x: 2319, y: 85, z: 508 }, owner: "Theo", label: "leveling 9x9" },
  { regionId: 3, dimension: "overworld", min: { x: 2307, y: 68, z: 487 }, max: { x: 2315, y: 75, z: 495 }, owner: "Theo", label: "small medieval house" },
  { regionId: 4, dimension: "overworld", min: { x: 2298, y: 68, z: 491 }, max: { x: 2306, y: 75, z: 499 }, owner: "Theo", label: "small medieval house" },
  { regionId: 5, dimension: "overworld", min: { x: 2303, y: 62, z: 490 }, max: { x: 2319, y: 78, z: 506 }, owner: "Tester", label: "improve_house" },
];

function theoBot(regions: readonly ProtectedRegion[]) {
  const bot = botFixture({ position: new Vec3(2302.47, 70, 494.5), items: [{ name: "dirt", count: 124 }] });
  setProtectedRegionsProvider(bot as never, () => regions);
  return bot;
}

const START = { x: 2302, y: 70, z: 494 };

function search(regions: readonly ProtectedRegion[], options?: Parameters<typeof createMovements>[1], clearOfToss?: { x: number; z: number }) {
  const goalCell = { x: 2296, y: 69, z: 486 };
  const bot = theoBot(regions);
  const target = clearOfToss === undefined ? exactBlockGoal(goalCell) : customGoal("clear-of-toss", (node) => Math.hypot(node.feet.x + 0.5 - clearOfToss.x, node.feet.z + 0.5 - clearOfToss.z) >= 4, (node) => Math.max(0, 4 - Math.hypot(node.feet.x + 0.5 - clearOfToss.x, node.feet.z + 0.5 - clearOfToss.z)) * 4.6);
  const goal = target.resolve(observation(START.x, START.y, START.z));
  if (goal.kind !== "active") throw new Error(goal.observation);
  return new IncrementalSearch({
    id: "theo", start: planningStart(START, 16), goal, now: () => 0,
    context: { world: theoArea(bot), policy: createMovements(bot, options), player: WELL_FED, catalogue: createMovementCatalogue() },
  }).advance({ maximumExpansions: 200_000, maximumMilliseconds: 10_000 });
}

const found = (update: { kind: string }) => update.kind === "complete" || update.kind === "segment_ready";

// Live 2026-10-11 (improve test, Theo): every route from 2302 70 494 failed "no path found after 0 ms; visited 13 nodes".
// The 3x3 house's door opens onto three cells walled at head height by dirt left from the 9x9 build, and the only ways
// out are to dig or place in cells of region #4, Theo's own 'small medieval house', which every route refuses.
test("Theo, shut in by dirt at head height inside his own house region, finds a way out", { skip: "reproduction of an open bug (B2): routes may not dig or place in the bot's own regions, even to leave one" }, () => {
  assert.ok(found(search(REGIONS)));
});

test("the same search finds the way out when region #4 does not exist (the region is what shuts Theo in)", () => {
  assert.ok(found(search(REGIONS.filter((region) => region.regionId !== 4))));
});

test("the same search finds the way out when the bot's own regions are open to it", () => {
  assert.ok(found(search(REGIONS, { ignoreRegionsOwnedBy: "Theo" })));
});

// Same stuck scene, drop_item's walk-off (live 2026-10-11, Theo: "[DROP_PICKED_UP] stone_pickaxe came back", nine items,
// five attempts at 10:35-10:36, all from 2302 70 494): the 4-block walk away from the toss has nowhere to go inside the
// cage (the room and the three cells outside the door are all within 3.5 blocks), so the toss is picked up again.
test("Theo's drop_item walk-off reaches 4 blocks from the toss", { skip: "reproduction of an open bug (B3 = B2): the cage leaves no cell 4 blocks away" }, () => {
  assert.ok(found(search(REGIONS, undefined, { x: 2302.47, z: 494.5 })));
});

test("without region #4 the walk-off reaches 4 blocks from the toss", () => {
  assert.ok(found(search(REGIONS.filter((region) => region.regionId !== 4), undefined, { x: 2302.47, z: 494.5 })));
});
