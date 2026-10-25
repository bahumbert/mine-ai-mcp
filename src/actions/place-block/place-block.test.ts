import { MemoryWorld as GoalTestWorld } from "../../navigation/world/memory-world.js";
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { temporaryBotData } from "../../test-support/bot-data.js";
import { createFakeClock } from "../../test-support/fake-bot/index.js";
import { parsePlaceBlockRequest } from "./contract.js";
import { formatPlaceBlockResult, executePlaceBlock, beginPlaceBlock, type PlaceBlockDependencies } from "./place-block.js";
import { cutByReflex, testWorld } from "./place-block-fixtures.test.js";

const goalTestWorld = new GoalTestWorld();

/** Place the block and report it, but leave the slot for the server to redraw later. */
function placeWithoutSlotUpdate(target: Vec3, putDown: (cell: Vec3) => unknown): PlaceBlockDependencies["placeBlock"] {
  return async (_bot, placement) => {
    placement.onSent?.();
    return { kind: "placed", block: putDown(target) } as never;
  };
}

const placedContainerKeys = (data: ReturnType<typeof temporaryBotData>) =>
  data.read("SELECT container_key, block_name, placed_by_bot_id FROM placed_containers ORDER BY container_key");

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
