import assert from "node:assert/strict";
import test from "node:test";
import type { Item } from "prismarine-item";
import { Vec3 } from "vec3";
import { type FakeClock, createFakeBot, itemOf } from "../test-support/fake-bot/index.js";
import { useItemAt } from "./item-use.js";

/** One client tick, in ms of clock. */
const TICK_MS = 50;

/**
 * A bot that carries `carried` and stands by a water source at (3, 63, 0) over obsidian. Its use of an item has the
 * server answer `ticksUntilEffect` ticks later, scripted here: the water cell turns to air and a held bucket fills
 * (the only bucket of a stack becomes the water bucket; one of several leaves the rest held and the water bucket in a
 * free slot). `calls` records what the code under test did, in order.
 */
function usingBot(ticksUntilEffect: number, carried: Readonly<Record<string, number>> = { bucket: 1 }) {
  const target = new Vec3(3, 63, 0);
  const calls: string[] = [];
  const harness = createFakeBot({ lagMs: ticksUntilEffect * TICK_MS, carried, cells: { "3,63,0": "water", "3,62,0": "obsidian" } });
  const { bot, inventory, server, world } = harness;
  const effect = () => {
    world.setCell(target, "air");
    const held = inventory.heldItem;
    if (held?.name !== "bucket") return;
    const water = itemOf(world.registry, "water_bucket");
    if (held.count === 1) inventory.updateSlot(held.slot, water);
    else {
      inventory.updateSlot(held.slot, itemOf(world.registry, "bucket", held.count - 1));
      inventory.updateSlot(inventory.firstEmptySlotRange(36, 45) ?? 9, water);
    }
  };
  const equip = bot.equip;
  bot.equip = async (item, destination) => {
    calls.push(`equip ${typeof item === "object" ? item?.name : item}`);
    await equip(item, destination);
  };
  const lookAt = bot.lookAt;
  bot.lookAt = async (point, force) => {
    calls.push(`look ${point.x},${point.y},${point.z} force=${force}`);
    await lookAt(point, force);
  };
  // Stopgap until the shared fake has `activateItem`/`deactivateItem` (gap reported to the master, M5): scripted here.
  bot.activateItem = () => {
    calls.push("use");
    bot.usingHeldItem = true;
    server.answer(effect);
  };
  bot.deactivateItem = () => {
    calls.push("release");
    bot.usingHeldItem = false;
  };
  const stack = (name: string): Item => bot.inventory.items().find((item) => item.name === name)!;
  return { ...harness, calls, target, stack, obsidian: bot.blockAt(new Vec3(3, 62, 0))! };
}

/** Whether `pending` has ended, read at any time. Stopgap until M2 merges `clock.settle`. */
function watch<T>(pending: Promise<T>): { readonly over: boolean } {
  const state = { over: false };
  void pending.then(
    () => (state.over = true),
    () => (state.over = true),
  );
  return state;
}

/** Move the clock `ms` on and hand back the use, which must be over by then. Stopgap until M2 merges `clock.settle`. */
async function settledAfter<T>(clock: FakeClock, ms: number, pending: Promise<T>): Promise<T> {
  const wait = watch(pending);
  await clock.advance(ms);
  assert.ok(wait.over, `the use still waits after ${ms} ms of clock`);
  return pending;
}

test("equips, looks with force, uses, and confirms the cell and the hand", async () => {
  const { bot, calls, clock, target, stack } = usingBot(3);
  const result = await settledAfter(
    clock,
    4 * TICK_MS,
    useItemAt(bot, {
      item: stack("bucket"),
      lookAt: { x: 3.5, y: 63.5, z: 0.5 },
      expectedCells: [{ position: target, matches: (block) => block.name === "air" }],
      expectedHeldItem: "water_bucket",
    }),
  );

  assert.deepEqual(result, { kind: "used" });
  assert.deepEqual(calls, ["equip bucket", "look 3.5,63.5,0.5 force=true", "use", "release"]);
});

test("an unconfirmed use reports what it observed, whichever evidence it was waiting for", async () => {
  const world = usingBot(1_000);
  const unchanged = await settledAfter(
    world.clock,
    6 * TICK_MS,
    useItemAt(world.bot, {
      item: world.stack("bucket"),
      lookAt: { x: 3.5, y: 63.5, z: 0.5 },
      expectedCells: [{ position: world.target, matches: (block) => block.name === "air" }],
      expectedHeldItem: "water_bucket",
      timeoutTicks: 5,
    }),
  );

  assert.equal(unchanged.kind, "failed");
  if (unchanged.kind !== "failed") return;
  assert.match(unchanged.error, /not confirmed within 5 ticks/);
  assert.match(unchanged.error, /\(3, 63, 0\)=water, hand=bucket/);
  assert.equal(world.bot.usingHeldItem, false, "an unconfirmed use still releases the item");

  // A water bucket already in inventory is not evidence of a new scoop.
  const carried = usingBot(1_000, { bucket: 2, water_bucket: 1 });
  const noGain = await settledAfter(
    carried.clock,
    6 * TICK_MS,
    useItemAt(carried.bot, {
      item: carried.stack("bucket"),
      lookAt: { x: 3.5, y: 63.9, z: 0.5 },
      expectedInventoryGain: { item: "water_bucket", count: 1 },
      timeoutTicks: 5,
    }),
  );

  assert.equal(noGain.kind, "failed");
  if (noGain.kind !== "failed") return;
  assert.match(noGain.error, /water_bucket inventory=1, expected at least 2/);
});

test("a stacked bucket fill is confirmed by a new inventory item while the empty bucket stays held", async () => {
  const { bot, clock, stack } = usingBot(2, { bucket: 2 });
  const result = await settledAfter(
    clock,
    3 * TICK_MS,
    useItemAt(bot, {
      item: stack("bucket"),
      lookAt: { x: 3.5, y: 63.9, z: 0.5 },
      expectedInventoryGain: { item: "water_bucket", count: 1 },
    }),
  );
  assert.deepEqual(result, { kind: "used" });
  assert.equal(bot.heldItem?.name, "bucket");
});

test("an item that acts on a block is used on the named face", async () => {
  const { bot, calls, clock, obsidian, stack, target } = usingBot(1, { flint_and_steel: 1 });
  const activated: string[] = [];
  bot.activateBlock = async (block, face) => {
    activated.push(`${block.name} ${face?.x},${face?.y},${face?.z}`);
    bot.activateItem();
  };
  const result = await settledAfter(
    clock,
    2 * TICK_MS,
    useItemAt(bot, {
      item: stack("flint_and_steel"),
      lookAt: { x: 3.5, y: 63.01, z: 0.5 },
      on: { block: obsidian, face: { x: 0, y: 1, z: 0 } },
      expectedCells: [{ position: target, matches: (block) => block.name === "air" }],
    }),
  );
  assert.deepEqual(result, { kind: "used" });
  assert.deepEqual(activated, ["obsidian 0,1,0"]);
  assert.equal(calls.filter((call) => call === "use").length, 1);
});

test("onSent fires once, after the equip and the look, right before the use goes out", async () => {
  const { bot, calls, clock, stack } = usingBot(1);
  const result = await settledAfter(
    clock,
    2 * TICK_MS,
    useItemAt(bot, {
      item: stack("bucket"),
      lookAt: { x: 3.5, y: 63.5, z: 0.5 },
      onSent: () => calls.push("sent"),
    }),
  );
  assert.deepEqual(result, { kind: "used" });
  assert.deepEqual(calls, ["equip bucket", "look 3.5,63.5,0.5 force=true", "sent", "use", "release"]);
});

test("onSent also fires before a use on a block, and not when the look throws or the signal aborts before the send", async () => {
  const onBlock = usingBot(1, { flint_and_steel: 1 });
  onBlock.bot.activateBlock = async () => {
    onBlock.calls.push("activateBlock");
  };
  await settledAfter(
    onBlock.clock,
    2 * TICK_MS,
    useItemAt(onBlock.bot, {
      item: onBlock.stack("flint_and_steel"),
      lookAt: { x: 3.5, y: 63.01, z: 0.5 },
      on: { block: onBlock.obsidian, face: { x: 0, y: 1, z: 0 } },
      onSent: () => onBlock.calls.push("sent"),
      timeoutTicks: 1,
    }),
  );
  assert.deepEqual(
    onBlock.calls.filter((call) => call === "sent" || call === "activateBlock"),
    ["sent", "activateBlock"],
  );

  let sent = 0;
  const countSent = () => {
    sent += 1;
  };
  const lookThrows = usingBot(1);
  lookThrows.bot.lookAt = async () => {
    throw new Error("look failed");
  };
  const failed = await useItemAt(lookThrows.bot, {
    item: lookThrows.stack("bucket"),
    lookAt: { x: 0, y: 0, z: 0 },
    onSent: countSent,
  });
  assert.equal(failed.kind, "failed");

  const stop = new AbortController();
  const abortBeforeSend = usingBot(1);
  abortBeforeSend.bot.lookAt = async () => {
    stop.abort();
  };
  await assert.rejects(
    useItemAt(abortBeforeSend.bot, {
      item: abortBeforeSend.stack("bucket"),
      lookAt: { x: 0, y: 0, z: 0 },
      signal: stop.signal,
      onSent: countSent,
    }),
    { name: "AbortError" },
  );
  assert.equal(sent, 0);
});

test("a hand that need not change is not waited on", async () => {
  const { bot, clock, stack, target } = usingBot(2, { flint_and_steel: 1 });
  const result = await settledAfter(
    clock,
    3 * TICK_MS,
    useItemAt(bot, {
      item: stack("flint_and_steel"),
      lookAt: { x: 3.5, y: 63.5, z: 0.5 },
      expectedCells: [{ position: target, matches: (block) => block.name === "air" }],
    }),
  );
  assert.deepEqual(result, { kind: "used" });
});

test("an unconfirmed use says how far the server clock moved after the use went out", async () => {
  // A stopped server sends no time packet; a running one sends a packet of 20 ticks each second (contract check
  // `world-age-per-second`): the 40 client ticks of the wait last 2 s of clock, two packets.
  for (const [serverRuns, expected] of [[false, 0], [true, 40]] as const) {
    const world = usingBot(1_000);
    if (!serverRuns) world.server.stop();
    const result = await settledAfter(
      world.clock,
      41 * TICK_MS,
      useItemAt(world.bot, {
        item: world.stack("bucket"),
        lookAt: { x: 3.5, y: 63.5, z: 0.5 },
        expectedCells: [{ position: world.target, matches: (block) => block.name === "air" }],
        timeoutTicks: 40,
      }),
    );
    assert.deepEqual(result.kind === "failed" ? result.serverTicksWaited : null, expected);
  }
});

/** Server wait: the world age (not client ticks) decides, and the wall clock bounds it. */
function serverWaitWorld(ticksUntilEffect = 1_000) {
  const world = usingBot(ticksUntilEffect);
  return { ...world, timing: { now: world.clock.now, sleep: world.clock.sleep } };
}

test("a server wait confirms an unchanged block only once the world age moved 40 ticks", async () => {
  const world = serverWaitWorld();
  const result = await settledAfter(
    world.clock,
    2_100,
    useItemAt(world.bot, {
      item: world.stack("bucket"),
      lookAt: { x: 3.5, y: 63.5, z: 0.5 },
      expectedCells: [{ position: world.target, matches: (block) => block.name === "air" }],
      serverWait: { ticks: 40, wallMs: 10_000, ...world.timing },
    }),
  );
  assert.equal(result.kind, "failed");
  if (result.kind !== "failed") return;
  assert.ok((result.serverTicksWaited ?? 0) >= 40);
  assert.equal(result.timedOut, undefined);
});

test("a server wait on a frozen world age ends on the wall clock and says it timed out", async () => {
  const world = serverWaitWorld();
  world.server.stop();
  const pending = useItemAt(world.bot, {
    item: world.stack("bucket"),
    lookAt: { x: 3.5, y: 63.5, z: 0.5 },
    expectedCells: [{ position: world.target, matches: (block) => block.name === "air" }],
    serverWait: { ticks: 40, wallMs: 10_000, ...world.timing },
  });
  const wait = watch(pending);

  await world.clock.advance(9_900);
  assert.equal(wait.over, false, "still inside the 10 s wall bound");
  const result = await settledAfter(world.clock, 150, pending);

  assert.equal(result.kind === "failed" ? result.timedOut : null, true);
  assert.equal(world.bot.usingHeldItem, false);
});

test("a server wait frozen 10 s then moving again still sees a change that arrives late", async () => {
  // The server answers the use only once it runs again: the cell turns to air 10 s after the use went out.
  const world = serverWaitWorld(0);
  world.server.stop();
  world.clock.after(10_000, () => world.server.resume());
  const pending = useItemAt(world.bot, {
    item: world.stack("bucket"),
    lookAt: { x: 3.5, y: 63.5, z: 0.5 },
    expectedCells: [{ position: world.target, matches: (block) => block.name === "air" }],
    serverWait: { ticks: 40, wallMs: 15_000, ...world.timing },
  });
  const wait = watch(pending);

  await world.clock.advance(9_900);
  assert.equal(wait.over, false, "the server has not answered yet");
  const result = await settledAfter(world.clock, 200, pending);

  assert.deepEqual(result, { kind: "used" });
});
