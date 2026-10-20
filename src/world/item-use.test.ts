import assert from "node:assert/strict";
import test from "node:test";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { useItemAt } from "./item-use.js";
import type { InventoryItem } from "./placement.js";

/** A bot whose world and hand change `ticksUntilEffect` ticks after the item is used. */
function usingBot(ticksUntilEffect: number, stackedBuckets = false) {
  const target = new Vec3(3, 63, 0);
  const calls: string[] = [];
  let ticksSinceUse = -1;
  const effected = () => ticksSinceUse >= ticksUntilEffect;
  const bot = {
    usingHeldItem: false,
    get heldItem() {
      return { name: effected() && !stackedBuckets ? "water_bucket" : "bucket" };
    },
    inventory: {
      items: () => [
        { name: "bucket", count: effected() ? 1 : 2 },
        { name: "water_bucket", count: effected() ? 1 : 0 },
      ],
    },
    equip: async (item: InventoryItem) => {
      calls.push(`equip ${item.name}`);
    },
    lookAt: async (point: Vec3, force: boolean) => {
      calls.push(`look ${point.x},${point.y},${point.z} force=${force}`);
    },
    activateItem: () => {
      calls.push("use");
      ticksSinceUse = 0;
      bot.usingHeldItem = true;
    },
    deactivateItem: () => {
      calls.push("release");
      bot.usingHeldItem = false;
    },
    waitForTicks: async () => {
      if (ticksSinceUse >= 0) ticksSinceUse += 1;
    },
    blockAt: (position: Vec3) =>
      position.equals(target) ? { name: effected() ? "air" : "water", position } : { name: "stone", position },
  } as unknown as Bot & { usingHeldItem: boolean };
  return { bot, calls, target };
}

test("equips, looks with force, uses, and confirms the cell and the hand", async () => {
  const { bot, calls, target } = usingBot(3);
  const result = await useItemAt(bot, {
    item: { name: "bucket" } as InventoryItem,
    lookAt: { x: 3.5, y: 63.5, z: 0.5 },
    expectedCells: [{ position: target, matches: (block) => block.name === "air" }],
    expectedHeldItem: "water_bucket",
  });

  assert.deepEqual(result, { kind: "used" });
  assert.deepEqual(calls, ["equip bucket", "look 3.5,63.5,0.5 force=true", "use", "release"]);
});

test("an unconfirmed use reports what it observed, whichever evidence it was waiting for", async () => {
  const world = usingBot(1_000);
  const unchanged = await useItemAt(world.bot, {
    item: { name: "bucket" } as InventoryItem,
    lookAt: { x: 3.5, y: 63.5, z: 0.5 },
    expectedCells: [{ position: world.target, matches: (block) => block.name === "air" }],
    expectedHeldItem: "water_bucket",
    timeoutTicks: 5,
  });

  assert.equal(unchanged.kind, "failed");
  if (unchanged.kind !== "failed") return;
  assert.match(unchanged.error, /not confirmed within 5 ticks/);
  assert.match(unchanged.error, /\(3, 63, 0\)=water, hand=bucket/);
  assert.equal(world.bot.usingHeldItem, false, "an unconfirmed use still releases the item");

  // A water bucket already in inventory is not evidence of a new scoop.
  const carried = usingBot(1_000);
  Object.defineProperty(carried.bot, "inventory", { value: { items: () => [{ name: "water_bucket", count: 1 }] } });
  const noGain = await useItemAt(carried.bot, {
    item: { name: "bucket", count: 2 } as InventoryItem,
    lookAt: { x: 3.5, y: 63.9, z: 0.5 },
    expectedInventoryGain: { item: "water_bucket", count: 1 },
    timeoutTicks: 5,
  });

  assert.equal(noGain.kind, "failed");
  if (noGain.kind !== "failed") return;
  assert.match(noGain.error, /water_bucket inventory=1, expected at least 2/);
});

test("a stacked bucket fill is confirmed by a new inventory item while the empty bucket stays held", async () => {
  const { bot } = usingBot(2, true);
  const result = await useItemAt(bot, {
    item: { name: "bucket", count: 2 } as InventoryItem,
    lookAt: { x: 3.5, y: 63.9, z: 0.5 },
    expectedInventoryGain: { item: "water_bucket", count: 1 },
  });
  assert.deepEqual(result, { kind: "used" });
  assert.equal(bot.heldItem?.name, "bucket");
});

test("an item that acts on a block is used on the named face", async () => {
  const { bot, calls, target } = usingBot(1);
  const activated: string[] = [];
  Object.assign(bot, {
    activateBlock: async (block: { name: string }, face: Vec3) => {
      activated.push(`${block.name} ${face.x},${face.y},${face.z}`);
      bot.activateItem();
    },
  });
  const result = await useItemAt(bot, {
    item: { name: "flint_and_steel" } as InventoryItem,
    lookAt: { x: 3.5, y: 63.01, z: 0.5 },
    on: { block: { name: "obsidian" } as never, face: { x: 0, y: 1, z: 0 } },
    expectedCells: [{ position: target, matches: (block) => block.name === "air" }],
  });
  assert.deepEqual(result, { kind: "used" });
  assert.deepEqual(activated, ["obsidian 0,1,0"]);
  assert.equal(calls.filter((call) => call === "use").length, 1);
});

test("onSent fires once, after the equip and the look, right before the use goes out", async () => {
  const { bot, calls } = usingBot(1);
  const result = await useItemAt(bot, {
    item: { name: "bucket" } as InventoryItem,
    lookAt: { x: 3.5, y: 63.5, z: 0.5 },
    onSent: () => calls.push("sent"),
  });
  assert.deepEqual(result, { kind: "used" });
  assert.deepEqual(calls, ["equip bucket", "look 3.5,63.5,0.5 force=true", "sent", "use", "release"]);
});

test("onSent also fires before a use on a block, and not when the look throws or the signal aborts before the send", async () => {
  const onBlock = usingBot(1);
  Object.assign(onBlock.bot, {
    activateBlock: async () => {
      onBlock.calls.push("activateBlock");
    },
  });
  await useItemAt(onBlock.bot, {
    item: { name: "flint_and_steel" } as InventoryItem,
    lookAt: { x: 3.5, y: 63.01, z: 0.5 },
    on: { block: { name: "obsidian" } as never, face: { x: 0, y: 1, z: 0 } },
    onSent: () => onBlock.calls.push("sent"),
    timeoutTicks: 1,
  });
  assert.deepEqual(
    onBlock.calls.filter((call) => call === "sent" || call === "activateBlock"),
    ["sent", "activateBlock"],
  );

  let sent = 0;
  const countSent = () => {
    sent += 1;
  };
  const lookThrows = usingBot(1);
  Object.assign(lookThrows.bot, {
    lookAt: async () => {
      throw new Error("look failed");
    },
  });
  const failed = await useItemAt(lookThrows.bot, {
    item: { name: "bucket" } as InventoryItem,
    lookAt: { x: 0, y: 0, z: 0 },
    onSent: countSent,
  });
  assert.equal(failed.kind, "failed");

  const stop = new AbortController();
  const abortBeforeSend = usingBot(1);
  Object.assign(abortBeforeSend.bot, {
    lookAt: async () => {
      stop.abort();
    },
  });
  await assert.rejects(
    useItemAt(abortBeforeSend.bot, {
      item: { name: "bucket" } as InventoryItem,
      lookAt: { x: 0, y: 0, z: 0 },
      signal: stop.signal,
      onSent: countSent,
    }),
    { name: "AbortError" },
  );
  assert.equal(sent, 0);
});

test("a hand that need not change is not waited on", async () => {
  const { bot, target } = usingBot(2);
  const result = await useItemAt(bot, {
    item: { name: "flint_and_steel" } as InventoryItem,
    lookAt: { x: 3.5, y: 63.5, z: 0.5 },
    expectedCells: [{ position: target, matches: (block) => block.name === "air" }],
  });
  assert.deepEqual(result, { kind: "used" });
});

test("an unconfirmed use says how far the server clock moved after the use went out", async () => {
  for (const [serverTicksPerClientTick, expected] of [[0, 0], [1, 5]] as const) {
    const world = usingBot(1_000);
    const time = { age: 1_000 };
    Object.defineProperty(world.bot, "time", { value: time });
    const wait = world.bot.waitForTicks;
    world.bot.waitForTicks = async (ticks?: number) => {
      time.age += serverTicksPerClientTick;
      return wait(ticks ?? 1);
    };
    const result = await useItemAt(world.bot, {
      item: { name: "bucket" } as InventoryItem,
      lookAt: { x: 3.5, y: 63.5, z: 0.5 },
      expectedCells: [{ position: world.target, matches: (block) => block.name === "air" }],
      timeoutTicks: 5,
    });
    assert.deepEqual(result.kind === "failed" ? result.serverTicksWaited : null, expected);
  }
});

/** Server wait: the world age (not client ticks) decides, and the wall clock bounds it. */
function serverWaitWorld(ageJumps: (wall: number) => number) {
  const world = usingBot(1_000);
  const time = { age: 1_000 };
  Object.defineProperty(world.bot, "time", { value: time });
  let wall = 0;
  const clock = {
    now: () => wall,
    sleep: async (ms: number) => {
      wall += ms;
      time.age += ageJumps(wall);
    },
  };
  return { ...world, clock, wall: () => wall };
}

test("a server wait confirms an unchanged block only once the world age moved 40 ticks", async () => {
  const world = serverWaitWorld(() => 20);
  const result = await useItemAt(world.bot, {
    item: { name: "bucket" } as InventoryItem,
    lookAt: { x: 3.5, y: 63.5, z: 0.5 },
    expectedCells: [{ position: world.target, matches: (block) => block.name === "air" }],
    serverWait: { ticks: 40, wallMs: 10_000, ...world.clock },
  });
  assert.equal(result.kind, "failed");
  if (result.kind !== "failed") return;
  assert.ok((result.serverTicksWaited ?? 0) >= 40);
  assert.equal(result.timedOut, undefined);
});

test("a server wait on a frozen world age ends on the wall clock and says it timed out", async () => {
  const world = serverWaitWorld(() => 0);
  const result = await useItemAt(world.bot, {
    item: { name: "bucket" } as InventoryItem,
    lookAt: { x: 3.5, y: 63.5, z: 0.5 },
    expectedCells: [{ position: world.target, matches: (block) => block.name === "air" }],
    serverWait: { ticks: 40, wallMs: 10_000, ...world.clock },
  });
  assert.equal(result.kind === "failed" ? result.timedOut : null, true);
  assert.ok(world.wall() >= 10_000);
  assert.equal(world.bot.usingHeldItem, false);
});

test("a server wait frozen 10 s then +200 still sees a change that arrives late", async () => {
  const world = serverWaitWorld((wall) => (wall === 10_000 ? 200 : 0));
  // The effect lands once the age jumps: client ticks never run in this wait.
  world.bot.waitForTicks = async () => {};
  const original = world.clock.sleep;
  let landed = false;
  world.clock.sleep = async (ms: number) => {
    await original(ms);
    if (world.wall() >= 10_000) landed = true;
  };
  const result = await useItemAt(world.bot, {
    item: { name: "bucket" } as InventoryItem,
    lookAt: { x: 3.5, y: 63.5, z: 0.5 },
    expectedCells: [{ position: world.target, matches: () => landed }],
    serverWait: { ticks: 40, wallMs: 15_000, ...world.clock },
  });
  assert.deepEqual(result, { kind: "used" });
});
