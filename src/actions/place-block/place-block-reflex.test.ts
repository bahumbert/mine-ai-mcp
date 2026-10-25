// place_block: a reflex cutting a placement and the resume that follows it.
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeClock } from "../../test-support/fake-bot/index.js";
import { formatPlaceBlockResult, beginPlaceBlock, type PlaceBlockDependencies } from "./place-block.js";
import { cutByReflex, testWorld } from "./place-block-fixtures.test.js";

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
