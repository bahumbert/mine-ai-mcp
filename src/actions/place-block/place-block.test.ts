import { MemoryWorld as GoalTestWorld } from "../../navigation/world/memory-world.js";
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { botFixture, type FakeStack } from "../../test-support/bot.js";
import { startServerClock } from "../../test-support/server-clock.js";
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
      placement.onSent?.(); // the real placeBlock calls it right before the packet
      assert.deepEqual(placement.support.position, target.offset(0, -1, 0));
      assert.deepEqual(placement.face, new Vec3(0, 1, 0));
      takeOneFromInventory();
      const placed = { name: "cobblestone", boundingBox: "block", position: target };
      blocks.set(key(target), placed);
      return { kind: "placed", block: placed } as never;
    },
    placeNearby: async (_bot, _name, options) => {
      const chosen = new Vec3(1, 64, 0);
      options?.onPlacementSent?.([chosen]); // the real one calls it right before the packet
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
  return async (_bot, placement) => {
    placement.onSent?.();
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

test("says so rather than presenting a placement count the server never confirmed", async (t) => {
  const { bot, blocks, dependencies, target } = testWorld();
  t.after(startServerClock(bot)); // the answer is "no count": the server's world age must move 40 ticks

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

// Resume credit (spec 2026-10-19, S1): a block is the request's own only when its own placement packet went to that
// cell. The fakes below send (call onSent / onPlacementSent) or are cut before the send, as the real equip and look can be.
const freshSignal = () => new AbortController().signal;
const targetRequest = { blockName: "cobblestone", target: { x: 2, y: 64, z: 0 } } as const;

/** What a fire reflex does to the world between two attempts: puts down a carried block of the same kind, spending one. */
function reflexPutsBlock(world: ReturnType<typeof testWorld>, cell: Vec3) {
  world.blocks.set(key(cell), { name: "cobblestone", boundingBox: "block", position: cell });
  world.takeOneFromInventory();
}

test("a reflex's block beside the bot is not taken for the request's", async (t) => {
  const world = testWorld();
  const { bot, blocks, dependencies } = world;
  t.after(startServerClock(bot)); // the reflex spent one of the blocks: the count the server confirms is two below
  let attempts = 0;
  const run = beginPlaceBlock(bot, { blockName: "cobblestone", target: null }, {
    ...dependencies,
    placeNearby: async (...args) => {
      attempts += 1;
      if (attempts === 1) throw cutByReflex().reason; // cut during the equip: nothing was sent
      return dependencies.placeNearby(...args);
    },
  });
  await assert.rejects(run({ signal: freshSignal() }), /HUNGER/);
  reflexPutsBlock(world, new Vec3(2, 64, 1));

  const result = await run({ signal: freshSignal() });

  assert.equal(result.status, "succeeded");
  assert.equal(result.placement.placed, true);
  assert.deepEqual(result.placement.target, { x: 1, y: 64, z: 0 }, "the request's own block, not the reflex's cell");
  assert.equal(attempts, 2);
  assert.equal([...blocks.values()].filter((block) => block.name === "cobblestone").length, 2);
});

test("a reflex's block in the target with the count fallen is already present, placed: false", async () => {
  const world = testWorld();
  const { bot, dependencies } = world;
  const run = beginPlaceBlock(bot, targetRequest, {
    ...dependencies,
    placeBlock: async () => {
      throw cutByReflex().reason; // cut before the send
    },
  });
  await assert.rejects(run({ signal: freshSignal() }), /HUNGER/);
  reflexPutsBlock(world, world.target);

  const result = await run({ signal: freshSignal() });

  assert.equal(result.status, "succeeded");
  assert.equal(result.placement.placed, false, "our packet never went there");
  assert.match(formatPlaceBlockResult(result), /already present/);
});

test("a slow server: the block of the cut attempt lands 600 ms after the resume began and is not placed twice", async () => {
  const world = testWorld();
  const { bot, dependencies } = world;
  let placements = 0;
  const run = beginPlaceBlock(bot, targetRequest, {
    ...dependencies,
    placeBlock: async (_bot, placement) => {
      placements += 1;
      placement.onSent?.();
      throw cutByReflex().reason; // sent, then cut: the block is still in flight
    },
  });
  await assert.rejects(run({ signal: freshSignal() }), /HUNGER/);
  setTimeout(() => reflexPutsBlock(world, world.target), 600); // the server's world age never moves here

  const result = await run({ signal: freshSignal() });

  assert.equal(result.status, "succeeded");
  assert.equal(result.placement.placed, true);
  assert.deepEqual([result.placement.inventoryBefore, result.placement.inventoryAfter], [2, 1]);
  assert.equal(placements, 1);
});

test("a sent placement that never landed is placed again once the world age moved 40 ticks", async () => {
  const world = testWorld();
  const { bot, dependencies } = world;
  let placements = 0;
  const run = beginPlaceBlock(bot, targetRequest, {
    ...dependencies,
    placeBlock: async (...args) => {
      placements += 1;
      if (placements > 1) return dependencies.placeBlock(...args);
      args[1].onSent?.();
      throw cutByReflex().reason;
    },
  });
  await assert.rejects(run({ signal: freshSignal() }), /HUNGER/);
  const stopClock = startServerClock(bot);

  const result = await run({ signal: freshSignal() });
  stopClock();

  assert.equal(result.status, "succeeded");
  assert.equal(result.placement.placed, true);
  assert.equal(placements, 2);
});

test("the sent cell unloaded after a reflex moved the bot fails naming the cell, and resumes once the bot is back", async () => {
  const world = testWorld();
  const { bot, dependencies } = world;
  const loaded = bot.blockAt.bind(bot);
  let unloaded = false;
  const run = beginPlaceBlock(bot, { blockName: "cobblestone", target: null }, {
    ...dependencies,
    placeNearby: async (...args) => {
      await dependencies.placeNearby(...args); // sent and landed
      throw cutByReflex().reason;
    },
  });
  await assert.rejects(run({ signal: freshSignal() }), /HUNGER/);
  Object.assign(bot, { blockAt: (cell: Vec3) => (unloaded && cell.x === 1 && cell.y === 64 && cell.z === 0 ? null : loaded(cell)) });
  unloaded = true;

  const failed = await run({ signal: freshSignal() });

  assert.equal(failed.status, "failed");
  if (failed.status === "failed") assert.match(failed.error, /\(1, 64, 0\).*not loaded.*go back near/su);
  unloaded = false;
  const resumed = await run({ signal: freshSignal() });
  assert.equal(resumed.status, "succeeded");
  assert.equal(resumed.placement.placed, true);
});

test("a death between attempts (inventory empty, far away) fails and credits nothing", async () => {
  const world = testWorld();
  const { bot, dependencies } = world;
  const run = beginPlaceBlock(bot, { blockName: "cobblestone", target: null }, {
    ...dependencies,
    placeNearby: async (...args) => {
      await dependencies.placeNearby(...args);
      throw cutByReflex().reason;
    },
  });
  await assert.rejects(run({ signal: freshSignal() }), /HUNGER/);
  (bot.inventory.items() as unknown[]).length = 0; // everything dropped where the bot died
  Object.assign(bot, { blockAt: () => null }); // respawned far from the chunk of the placement

  const result = await run({ signal: freshSignal() });

  assert.equal(result.status, "failed");
  assert.notEqual(result.placement.placed, true);
});

test("two place requests on two bots keep their own cells", async () => {
  const first = testWorld();
  const second = testWorld();
  const cutOnce = (world: ReturnType<typeof testWorld>) => {
    let cut = false;
    return beginPlaceBlock(world.bot, { blockName: "cobblestone", target: null }, {
      ...world.dependencies,
      placeNearby: async (...args) => {
        if (cut) throw new Error("a landed placement must not be placed again");
        await world.dependencies.placeNearby(...args);
        cut = true;
        throw cutByReflex().reason;
      },
    });
  };
  const runs = [cutOnce(first), cutOnce(second)];
  await Promise.all(runs.map((run) => assert.rejects(run({ signal: freshSignal() }), /HUNGER/)));
  reflexPutsBlock(second, new Vec3(0, 64, 1)); // a reflex of the second bot only: its count falls by two
  const stopClock = startServerClock(second.bot);

  const results = await Promise.all(runs.map((run) => run({ signal: freshSignal() })));
  stopClock();

  assert.deepEqual(results.map((result) => result.placement.target), [{ x: 1, y: 64, z: 0 }, { x: 1, y: 64, z: 0 }]);
  assert.deepEqual(results.map((result) => result.placement.placed), [true, true]);
});
