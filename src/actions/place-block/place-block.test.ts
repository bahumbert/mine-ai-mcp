import { MemoryWorld as GoalTestWorld } from "../../navigation/world/memory-world.js";
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { botFixture, type FakeStack } from "../../test-support/bot.js";
import { parsePlaceBlockRequest } from "./contract.js";
import { formatPlaceBlockResult, executePlaceBlock, beginPlaceBlock, type PlaceBlockDependencies } from "./place-block.js";

const goalTestWorld = new GoalTestWorld();

function key(position: Vec3): string {
  return `${position.x},${position.y},${position.z}`;
}

function testWorld(targetName = "air", carried = 2) {
  const target = new Vec3(2, 64, 0);
  const blocks = new Map<string, any>([
    [key(target), { name: targetName, boundingBox: targetName === "air" ? "empty" : "block", position: target }],
    [key(target.offset(0, -1, 0)), { name: "stone", boundingBox: "block", position: target.offset(0, -1, 0) }],
  ]);
  const items: FakeStack[] = carried > 0 ? [{ name: "cobblestone", count: carried }] : [];
  const bot = botFixture(
    { items, position: { x: 0, y: 64, z: 0 } },
    { blockAt: (position: Vec3) => blocks.get(key(position)) ?? { name: "air", boundingBox: "empty", position } },
  );
  /** What the server's own broadcast does: change the count, then say so. */
  const takeOneFromInventory = () => {
    items[0]!.count -= 1;
    if (items[0]!.count === 0) items.pop();
    bot.inventory.emit("updateSlot");
  };
  const dependencies: PlaceBlockDependencies = {
    createMovements: () => ({}) as never,
    navigate: async () => ({ status: "completed", elapsedMs: 0 }),
    placeBlock: async (_bot, placement) => {
      assert.deepEqual(placement.support.position, target.offset(0, -1, 0));
      assert.deepEqual(placement.face, new Vec3(0, 1, 0));
      takeOneFromInventory();
      const placed = { name: "cobblestone", boundingBox: "block", position: target };
      blocks.set(key(target), placed);
      return { kind: "placed", block: placed } as never;
    },
    placeNearby: async () => {
      const chosen = new Vec3(1, 64, 0);
      takeOneFromInventory();
      const placed = { name: "cobblestone", boundingBox: "block", position: chosen };
      blocks.set(key(chosen), placed);
      return { kind: "placed", position: chosen, block: placed as never };
    },
  };
  return { bot, blocks, dependencies, target, takeOneFromInventory };
}

test("parses one normalized block name and exact absolute target", () => {
  assert.deepEqual(parsePlaceBlockRequest({ block_name: "Minecraft:Cobble Stone", x: 2, y: 64, z: 0 }), {
    blockName: "cobble_stone",
    target: { x: 2, y: 64, z: 0 },
  });
  assert.deepEqual(parsePlaceBlockRequest({ block_name: "crafting_table" }), {
    blockName: "crafting_table",
    target: null,
  });
  assert.throws(() => parsePlaceBlockRequest({ block_name: "crafting_table", x: 1 }), /all of x, y, and z/);
});

test("chooses a cell beside the bot when no target is given", async () => {
  const { bot, dependencies } = testWorld();
  const result = await executePlaceBlock(bot, { blockName: "cobblestone", target: null }, {}, dependencies);

  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.placement.target, { x: 1, y: 64, z: 0 });
  assert.equal(result.placement.placed, true);
  assert.equal(result.placement.inventoryAfter, 1);
});

test("places against the supporting block below and verifies world and inventory evidence", async () => {
  const { bot, dependencies } = testWorld();
  const result = await executePlaceBlock(
    bot,
    { blockName: "cobblestone", target: { x: 2, y: 64, z: 0 } },
    {},
    dependencies,
  );

  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.placement, {
    dimension: "overworld",
    requestedBlock: "cobblestone",
    target: { x: 2, y: 64, z: 0 },
    beforeBlock: "air",
    afterBlock: "cobblestone",
    inventoryBefore: 2,
    inventoryAfter: 1,
    confirmed: true,
    placed: true,
    support: { x: 2, y: 63, z: 0 },
    face: { x: 0, y: 1, z: 0 },
  });
  assert.match(formatPlaceBlockResult(result), /Placed \*\*cobblestone\*\*/);
});

test("an exact target inside the bot's body requires movement before placement", async () => {
  const { bot, dependencies, target } = testWorld();
  bot.entity.position = target.offset(0.5, 0, 0.5);
  let moved = false;
  const result = await executePlaceBlock(
    bot,
    { blockName: "cobblestone", target },
    {},
    {
      ...dependencies,
      navigate: async ({ goal }) => {
        const feet = { x: 3, y: 64, z: 0 };
        const node = { feet, remainingScaffolds: 0, overlayId: "0" };
        for (const y of [64, 63.875]) {
          const straddling = goal.resolve({ position: new Vec3(3.1, y, 0.5), stance: "supported" } as never);
          const clear = goal.resolve({ position: new Vec3(3.4, y, 0.5), stance: "supported" } as never);
          assert.equal(straddling.kind, "active");
          assert.equal(clear.kind, "active");
          if (straddling.kind === "active" && clear.kind === "active") {
            assert.equal(
              straddling.isSatisfied(node, goalTestWorld),
              false,
              `the actual body overlaps at floor y=${y}`,
            );
            assert.equal(clear.isSatisfied(node, goalTestWorld), true);
            assert.notEqual(straddling.revision, clear.revision);
          }
        }
        moved = true;
        bot.entity.position = target.offset(1.5, 0, 0.5);
        return { status: "completed", elapsedMs: 0 };
      },
      placeBlock: async (...args) => {
        assert.equal(moved, true);
        return dependencies.placeBlock(...args);
      },
    },
  );
  assert.equal(result.status, "succeeded");
});

test("a reported arrival that still overlaps the target does not send a placement", async () => {
  const { bot, dependencies, target } = testWorld();
  bot.entity.position = target.offset(0.5, 0, 0.5);
  const result = await executePlaceBlock(
    bot,
    { blockName: "cobblestone", target },
    {},
    {
      ...dependencies,
      placeBlock: async () => {
        throw new Error("must not place through the bot");
      },
    },
  );
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /body still intersects/);
});

/** Place the block and report it, but leave the slot for the server to redraw later. */
function placeWithoutSlotUpdate(target: Vec3, blocks: Map<string, any>): PlaceBlockDependencies["placeBlock"] {
  return async () => {
    const placed = { name: "cobblestone", boundingBox: "block", position: target };
    blocks.set(key(target), placed);
    return { kind: "placed", block: placed } as never;
  };
}

test("waits for the slot update the server sends after the block update", async () => {
  const { bot, blocks, dependencies, target, takeOneFromInventory } = testWorld();
  // The block update resolved `placeBlock`; the slot that loses the block is
  // broadcast two ticks later.
  setTimeout(takeOneFromInventory, 100);

  const result = await executePlaceBlock(
    bot,
    { blockName: "cobblestone", target: { x: 2, y: 64, z: 0 } },
    {},
    { ...dependencies, placeBlock: placeWithoutSlotUpdate(target, blocks) },
  );

  assert.equal(result.status, "succeeded");
  assert.deepEqual(
    [result.placement.inventoryBefore, result.placement.inventoryAfter, result.placement.confirmed],
    [2, 1, true],
  );
});

test("says so rather than presenting a placement count the server never confirmed", async () => {
  const { bot, blocks, dependencies, target } = testWorld();

  const result = await executePlaceBlock(
    bot,
    { blockName: "cobblestone", target: { x: 2, y: 64, z: 0 } },
    {},
    { ...dependencies, placeBlock: placeWithoutSlotUpdate(target, blocks) },
  );

  assert.equal(result.status, "succeeded");
  assert.deepEqual(
    [result.placement.inventoryBefore, result.placement.inventoryAfter, result.placement.confirmed],
    [2, 2, false],
  );
  assert.match(formatPlaceBlockResult(result), /had not confirmed this count within the deadline/);
});

test("treats an already matching target as satisfied without consuming inventory", async () => {
  const { bot, dependencies } = testWorld("cobblestone");
  const result = await executePlaceBlock(
    bot,
    { blockName: "cobblestone", target: { x: 2, y: 64, z: 0 } },
    {},
    dependencies,
  );

  assert.equal(result.status, "succeeded");
  assert.equal(result.placement.placed, false);
  assert.equal(result.placement.inventoryAfter, 2);
  assert.match(formatPlaceBlockResult(result), /already present/);
});

test("refuses to overwrite an occupied target", async () => {
  const { bot, dependencies } = testWorld("dirt");
  const result = await executePlaceBlock(
    bot,
    { blockName: "cobblestone", target: { x: 2, y: 64, z: 0 } },
    {},
    dependencies,
  );

  assert.equal(result.status, "failed");
  if (result.status === "failed") assert.match(result.error, /^\[PLACE_TARGET_OCCUPIED\]/);
  assert.equal(result.placement.afterBlock, "dirt");
});

test("refuses placement when the carried block is absent", async () => {
  const { bot, dependencies } = testWorld("air", 0);
  const result = await executePlaceBlock(
    bot,
    { blockName: "cobblestone", target: { x: 2, y: 64, z: 0 } },
    {},
    dependencies,
  );

  assert.equal(result.status, "failed");
  if (result.status === "failed") assert.match(result.error, /^\[PLACE_ITEM_MISSING\]/);
});

// Reflex continuity (spec 2026-10-18, R2): a reflex that takes the body mid-placement hands it back, and the resumed
// attempt never puts down a second block.
const cutByReflex = () => {
  const controller = new AbortController();
  controller.abort(new Error("[HUNGER] reflex"));
  return controller.signal;
};

test("a block that landed just before the reflex's abort threw is reported placed once after the resume", async () => {
  const { bot, dependencies } = testWorld();
  let placements = 0;
  const cutting: PlaceBlockDependencies = {
    ...dependencies,
    placeBlock: async (...args) => {
      placements += 1;
      await dependencies.placeBlock(...args);
      throw cutByReflex().reason;
    },
  };
  const run = beginPlaceBlock(bot, { blockName: "cobblestone", target: { x: 2, y: 64, z: 0 } }, cutting);
  await assert.rejects(run({ signal: new AbortController().signal }), /HUNGER/);
  const result = await run({ signal: new AbortController().signal });
  assert.equal(result.status, "succeeded");
  assert.equal(result.placement.placed, true, "the block is ours: the inventory fell from the begin baseline");
  assert.deepEqual([result.placement.inventoryBefore, result.placement.inventoryAfter], [2, 1]);
  assert.equal(result.placement.beforeBlock, "air");
  assert.equal(placements, 1);
});

test("a cell chosen beside the bot is found again after the abort threw, and no second block goes down", async () => {
  const { bot, dependencies } = testWorld();
  let placements = 0;
  const cutting: PlaceBlockDependencies = {
    ...dependencies,
    placeNearby: async (...args) => {
      placements += 1;
      await dependencies.placeNearby(...args);
      throw cutByReflex().reason;
    },
  };
  const run = beginPlaceBlock(bot, { blockName: "cobblestone", target: null }, cutting);
  await assert.rejects(run({ signal: new AbortController().signal }), /HUNGER/);
  const result = await run({ signal: new AbortController().signal });
  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.placement.target, { x: 1, y: 64, z: 0 });
  assert.equal(result.placement.placed, true);
  assert.equal(result.placement.inventoryAfter, 1);
  assert.equal(placements, 1);
});

test("a cell chosen beside the bot already holding the block before the request is not mistaken for the placed one", async () => {
  const { bot, blocks, dependencies } = testWorld();
  const old = new Vec3(0, 64, 1);
  blocks.set(key(old), { name: "cobblestone", boundingBox: "block", position: old });
  const cutting: PlaceBlockDependencies = {
    ...dependencies,
    placeNearby: async (...args) => {
      await dependencies.placeNearby(...args);
      throw cutByReflex().reason;
    },
  };
  const run = beginPlaceBlock(bot, { blockName: "cobblestone", target: null }, cutting);
  await assert.rejects(run({ signal: new AbortController().signal }));
  const result = await run({ signal: new AbortController().signal });
  assert.deepEqual(result.placement.target, { x: 1, y: 64, z: 0 });
});

test("a resume after a nearby placement that never landed places the block, once", async () => {
  const { bot, dependencies } = testWorld();
  let placements = 0;
  const run = beginPlaceBlock(bot, { blockName: "cobblestone", target: null }, {
    ...dependencies,
    placeNearby: async (...args) => {
      placements += 1;
      if (placements === 1) throw cutByReflex().reason;
      return dependencies.placeNearby(...args);
    },
  });
  await assert.rejects(run({ signal: new AbortController().signal }));
  const result = await run({ signal: new AbortController().signal });
  assert.equal(result.placement.placed, true);
  assert.equal(placements, 2);
  assert.equal(result.placement.inventoryAfter, 1);
});

test("the same block put in the target by someone else between the attempts is present, not ours", async () => {
  const { bot, blocks, dependencies, target } = testWorld();
  const cutting: PlaceBlockDependencies = {
    ...dependencies,
    placeBlock: async () => { throw cutByReflex().reason; },
  };
  const run = beginPlaceBlock(bot, { blockName: "cobblestone", target: { x: 2, y: 64, z: 0 } }, cutting);
  await assert.rejects(run({ signal: new AbortController().signal }));
  blocks.set(key(target), { name: "cobblestone", boundingBox: "block", position: target });
  const result = await run({ signal: new AbortController().signal });
  assert.equal(result.status, "succeeded");
  assert.equal(result.placement.placed, false);
  assert.equal(result.placement.inventoryAfter, 2);
});

test("another block put in the target between the attempts is refused as occupied", async () => {
  const { bot, blocks, dependencies, target } = testWorld();
  const run = beginPlaceBlock(bot, { blockName: "cobblestone", target: { x: 2, y: 64, z: 0 } }, {
    ...dependencies,
    placeBlock: async () => { throw cutByReflex().reason; },
  });
  await assert.rejects(run({ signal: new AbortController().signal }));
  blocks.set(key(target), { name: "dirt", boundingBox: "block", position: target });
  const result = await run({ signal: new AbortController().signal });
  assert.equal(result.status, "failed");
});

test("a placement that already finished answers a second call with the same success and places nothing", async () => {
  const { bot, dependencies } = testWorld();
  let placements = 0;
  const counting: PlaceBlockDependencies = {
    ...dependencies,
    placeBlock: async (...args) => { placements += 1; return dependencies.placeBlock(...args); },
  };
  const run = beginPlaceBlock(bot, { blockName: "cobblestone", target: { x: 2, y: 64, z: 0 } }, counting);
  const first = await run({ signal: new AbortController().signal });
  const again = await run({ signal: new AbortController().signal });
  assert.equal(first.placement.placed, true);
  assert.equal(again.status, "succeeded");
  assert.equal(again.placement.placed, true);
  assert.equal(placements, 1);
});
