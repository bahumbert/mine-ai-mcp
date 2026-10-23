import { MemoryWorld as GoalTestWorld } from "../../navigation/world/memory-world.js";
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { temporaryBotData } from "../../test-support/bot-data.js";
import { carriedCountField } from "../../test-support/carried-counts.js";
import { type FakeClock, createFakeBot, createFakeClock } from "../../test-support/fake-bot/index.js";
import { parsePlaceBlockRequest } from "./contract.js";
import { formatPlaceBlockResult, executePlaceBlock, beginPlaceBlock, type PlaceBlockDependencies } from "./place-block.js";

const goalTestWorld = new GoalTestWorld();

/**
 * A bot at (0, 64, 0) on a stone floor, carrying `carried` of `carriedBlock`, with `targetName` at (2, 64, 0). A test
 * whose action waits on the server's answer (the world age, the wall bound) passes a mocked clock it installed.
 */
function testWorld(targetName = "air", carried = 2, carriedBlock = "cobblestone", clock?: FakeClock) {
  const target = new Vec3(2, 64, 0);
  const harness = createFakeBot({
    ...(clock && { clock }),
    position: new Vec3(0, 64, 0),
    cells: { [`${target.x},${target.y},${target.z}`]: targetName },
    carried: carried > 0 ? { [carriedBlock]: carried } : {},
  });
  const { bot, world } = harness;
  const carriedCount = carriedCountField(harness, carriedBlock);
  /** What the server's own broadcast does: change the count, then say so (a slot update). */
  const takeOneFromInventory = () => {
    carriedCount.count -= 1;
  };
  /** The block the server put down at `cell`, as the block update shows it. */
  const putDown = (cell: Vec3, name = carriedBlock) => {
    world.setCell(cell, name);
    return world.blockAt(cell)!;
  };
  const dependencies: PlaceBlockDependencies = {
    createMovements: () => ({}) as never,
    navigate: async () => ({ status: "completed", elapsedMs: 0 }),
    placeBlock: async (_bot, placement) => {
      placement.onSent?.(); // the real placeBlock calls it right before the packet
      assert.deepEqual(placement.support.position, target.offset(0, -1, 0));
      assert.deepEqual(placement.face, new Vec3(0, 1, 0));
      takeOneFromInventory();
      return { kind: "placed", block: putDown(target) } as never;
    },
    placeNearby: async (_bot, _name, options) => {
      const chosen = new Vec3(1, 64, 0);
      options?.onPlacementSent?.([chosen]); // the real one calls it right before the packet
      takeOneFromInventory();
      return { kind: "placed", position: chosen, block: putDown(chosen) as never };
    },
  };
  return { harness, bot, world, putDown, carriedCount, dependencies, target, takeOneFromInventory };
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
function placeWithoutSlotUpdate(target: Vec3, putDown: (cell: Vec3) => unknown): PlaceBlockDependencies["placeBlock"] {
  return async (_bot, placement) => {
    placement.onSent?.();
    return { kind: "placed", block: putDown(target) } as never;
  };
}

test("waits for the slot update the server sends after the block update", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _installed = clock.install();
  const { bot, putDown, dependencies, target, takeOneFromInventory } = testWorld("air", 2, "cobblestone", clock);
  // The block update resolved `placeBlock`; the slot that loses the block is
  // broadcast two ticks later.
  clock.after(100, takeOneFromInventory);

  const result = await clock.settle(
    executePlaceBlock(
      bot,
      { blockName: "cobblestone", target: { x: 2, y: 64, z: 0 } },
      {},
      { ...dependencies, placeBlock: placeWithoutSlotUpdate(target, putDown) },
    ),
    1_000,
  );

  assert.equal(result.status, "succeeded");
  assert.deepEqual(
    [result.placement.inventoryBefore, result.placement.inventoryAfter, result.placement.confirmed],
    [2, 1, true],
  );
});

test("says so rather than presenting a placement count the server never confirmed", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _installed = clock.install();
  const { bot, putDown, dependencies, target } = testWorld("air", 2, "cobblestone", clock);
  // The answer is "no count", and the server answered: its world age moves 40 ticks (2 s of clock), short of the
  // 5 s wall bound the settle stops within.
  const result = await clock.settle(
    executePlaceBlock(
      bot,
      { blockName: "cobblestone", target: { x: 2, y: 64, z: 0 } },
      {},
      { ...dependencies, placeBlock: placeWithoutSlotUpdate(target, putDown) },
    ),
    3_000,
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
  const { bot, putDown, dependencies } = testWorld();
  const old = new Vec3(0, 64, 1);
  putDown(old);
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
  const { bot, putDown, dependencies, target } = testWorld();
  const cutting: PlaceBlockDependencies = {
    ...dependencies,
    placeBlock: async () => { throw cutByReflex().reason; },
  };
  const run = beginPlaceBlock(bot, { blockName: "cobblestone", target: { x: 2, y: 64, z: 0 } }, cutting);
  await assert.rejects(run({ signal: new AbortController().signal }));
  putDown(target);
  const result = await run({ signal: new AbortController().signal });
  assert.equal(result.status, "succeeded");
  assert.equal(result.placement.placed, false);
  assert.equal(result.placement.inventoryAfter, 2);
});

test("another block put in the target between the attempts is refused as occupied", async () => {
  const { bot, putDown, dependencies, target } = testWorld();
  const run = beginPlaceBlock(bot, { blockName: "cobblestone", target: { x: 2, y: 64, z: 0 } }, {
    ...dependencies,
    placeBlock: async () => { throw cutByReflex().reason; },
  });
  await assert.rejects(run({ signal: new AbortController().signal }));
  putDown(target, "dirt");
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
  world.putDown(cell);
  world.takeOneFromInventory();
}

/** The cobblestone blocks in the 7 x 7 cells around the bot at its feet level: where every placement here goes. */
function cobblestoneAround(world: ReturnType<typeof testWorld>): number {
  let found = 0;
  for (let x = -3; x <= 3; x += 1)
    for (let z = -3; z <= 3; z += 1) if (world.world.blockAt(new Vec3(x, 64, z))?.name === "cobblestone") found += 1;
  return found;
}

test("a reflex's block beside the bot is not taken for the request's", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _installed = clock.install();
  const world = testWorld("air", 2, "cobblestone", clock);
  const { bot, dependencies } = world;
  // The reflex spent one of the blocks: the count the server confirms is two below, never the one below the settle
  // waits for, so the wait ends on the server's answer (40 ticks of world age, 2 s of clock), short of the wall bound.
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

  const result = await clock.settle(run({ signal: freshSignal() }), 3_000);

  assert.equal(result.status, "succeeded");
  assert.equal(result.placement.placed, true);
  assert.deepEqual(result.placement.target, { x: 1, y: 64, z: 0 }, "the request's own block, not the reflex's cell");
  assert.equal(attempts, 2);
  assert.equal(cobblestoneAround(world), 2);
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
  const clock = createFakeClock({ mode: "mocked" });
  using _installed = clock.install();
  const world = testWorld("air", 2, "cobblestone", clock);
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
  // The server's world age never moves here (a stopped server): the wait ends on the block landing at 600 ms, short of
  // the 5 s wall bound the settle stops within.
  world.harness.server.stop();
  clock.after(600, () => reflexPutsBlock(world, world.target));

  const result = await clock.settle(run({ signal: freshSignal() }), 4_000);

  assert.equal(result.status, "succeeded");
  assert.equal(result.placement.placed, true);
  assert.deepEqual([result.placement.inventoryBefore, result.placement.inventoryAfter], [2, 1]);
  assert.equal(placements, 1);
});

test("a sent placement that never landed is placed again once the world age moved 40 ticks", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _installed = clock.install();
  const world = testWorld("air", 2, "cobblestone", clock);
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

  // The server answered without the block: its world age moves 40 ticks past the send (2 s of clock), short of the
  // 5 s wall bound the settle stops within.
  const result = await clock.settle(run({ signal: freshSignal() }), 3_000);

  assert.equal(result.status, "succeeded");
  assert.equal(result.placement.placed, true);
  assert.equal(placements, 2);
});

test("the sent cell unloaded after a reflex moved the bot fails naming the cell, and resumes once the bot is back", async () => {
  const world = testWorld();
  const { bot, dependencies } = world;
  const sent = new Vec3(1, 64, 0);
  const run = beginPlaceBlock(bot, { blockName: "cobblestone", target: null }, {
    ...dependencies,
    placeNearby: async (...args) => {
      await dependencies.placeNearby(...args); // sent and landed
      throw cutByReflex().reason;
    },
  });
  await assert.rejects(run({ signal: freshSignal() }), /HUNGER/);
  world.world.setCell(sent, "void");

  const failed = await run({ signal: freshSignal() });

  assert.equal(failed.status, "failed");
  if (failed.status === "failed") assert.match(failed.error, /\(1, 64, 0\).*not loaded.*go back near/su);
  world.world.setCell(sent, "cobblestone");
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
  world.carriedCount.count = 0; // everything dropped where the bot died
  bot.blockAt = () => null; // respawned far from the chunk of the placement

  const result = await run({ signal: freshSignal() });

  assert.equal(result.status, "failed");
  assert.notEqual(result.placement.placed, true);
});

test("two place requests on two bots keep their own cells", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _installed = clock.install();
  const first = testWorld("air", 2, "cobblestone", clock);
  const second = testWorld("air", 2, "cobblestone", clock);
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

  // The second bot's count never reaches the one below it waits for: its wait ends on the server's answer (40 ticks of
  // world age, 2 s of clock), short of the 5 s wall bound the settle stops within.
  const results = await clock.settle(Promise.all(runs.map((run) => run({ signal: freshSignal() }))), 3_000);

  assert.deepEqual(results.map((result) => result.placement.target), [{ x: 1, y: 64, z: 0 }, { x: 1, y: 64, z: 0 }]);
  assert.deepEqual(results.map((result) => result.placement.placed), [true, true]);
});

const placedContainerKeys = (data: ReturnType<typeof temporaryBotData>) =>
  data.read("SELECT container_key, block_name, placed_by_bot_id FROM placed_containers ORDER BY container_key");

test("a chest placed by place_block is recorded as placed by the bot, in its dimension", async (t) => {
  const data = temporaryBotData({ closeAfter: t });
  const { bot, dependencies } = testWorld("air", 2, "chest");

  const result = await executePlaceBlock(bot, { blockName: "chest", target: { x: 2, y: 64, z: 0 } }, {}, dependencies, data);

  assert.equal(result.status, "succeeded");
  assert.deepEqual(placedContainerKeys(data), [
    { container_key: "overworld|2|64|0", block_name: "chest", placed_by_bot_id: bot.username },
  ]);
});

test("a chest put beside the bot, no target given, is recorded where it went", async (t) => {
  const data = temporaryBotData({ closeAfter: t });
  const { bot, dependencies } = testWorld("air", 2, "chest");

  const result = await executePlaceBlock(bot, { blockName: "chest", target: null }, {}, dependencies, data);

  assert.equal(result.status, "succeeded");
  assert.deepEqual(
    placedContainerKeys(data).map((row) => row.container_key),
    ["overworld|1|64|0"],
  );
});

test("a placed block that is no container records nothing", async (t) => {
  const data = temporaryBotData({ closeAfter: t });
  const { bot, dependencies } = testWorld();

  await executePlaceBlock(bot, { blockName: "cobblestone", target: { x: 2, y: 64, z: 0 } }, {}, dependencies, data);

  assert.deepEqual(placedContainerKeys(data), []);
});

test("a chest that was already at the target, or that a reflex put there, is not recorded as ours", async (t) => {
  const data = temporaryBotData({ closeAfter: t });
  const { bot, dependencies } = testWorld("chest", 2, "chest");

  const result = await executePlaceBlock(bot, { blockName: "chest", target: { x: 2, y: 64, z: 0 } }, {}, dependencies, data);

  assert.equal(result.status, "succeeded");
  assert.equal(result.placement.placed, false);
  assert.deepEqual(placedContainerKeys(data), []);
});

test("a failed placement of a chest records nothing", async (t) => {
  const data = temporaryBotData({ closeAfter: t });
  const { bot, dependencies } = testWorld("air", 2, "chest");

  const result = await executePlaceBlock(
    bot,
    { blockName: "chest", target: { x: 2, y: 64, z: 0 } },
    {},
    { ...dependencies, placeBlock: async () => ({ kind: "failed", error: "no packet answer" }) },
    data,
  );

  assert.equal(result.status, "failed");
  assert.deepEqual(placedContainerKeys(data), []);
});

test("a chest that landed just before the reflex's abort threw is recorded once, when the resume credits it", async (t) => {
  const data = temporaryBotData({ closeAfter: t });
  const { bot, dependencies } = testWorld("air", 2, "chest");
  const cutting: PlaceBlockDependencies = {
    ...dependencies,
    placeBlock: async (...args) => {
      await dependencies.placeBlock(...args);
      throw cutByReflex().reason;
    },
  };
  const run = beginPlaceBlock(bot, { blockName: "chest", target: { x: 2, y: 64, z: 0 } }, cutting, () => {}, data);
  await assert.rejects(run({ signal: new AbortController().signal }), /HUNGER/);
  assert.deepEqual(placedContainerKeys(data), [], "nothing is credited while the attempt is cut");

  const result = await run({ signal: new AbortController().signal });

  assert.equal(result.status, "succeeded");
  assert.deepEqual(
    placedContainerKeys(data).map((row) => row.container_key),
    ["overworld|2|64|0"],
  );
});
