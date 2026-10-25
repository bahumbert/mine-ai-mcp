import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createMovements, type NavigationRuntime } from "../../navigation/index.js";
import { carriedCountField } from "../../test-support/carried-counts.js";
import { createFakeBot, createFakeClock, itemOf } from "../../test-support/fake-bot/index.js";
import { recoverEyeDrop } from "./recover-eye.js";

const DROP_ID = 90;

/**
 * A bot carrying 15 eyes and an eye drop it has not seen yet. The recovery's waits (the drop's 1.5 s, the pickup's
 * settle) are global timers: the mocked clock moves them, installed by each test.
 */
function fixture() {
  const clock = createFakeClock({ mode: "mocked" });
  const harness = createFakeBot({
    clock,
    position: new Vec3(0, 64, 0),
    carried: { ender_eye: 15 },
    entities: {
      [DROP_ID]: {
        name: "item",
        position: new Vec3(12, 64, 0),
        getDroppedItem: () => itemOf(harness.bot.registry, "ender_eye", 1),
      },
    },
  });
  const { bot } = harness;
  const eyes = carriedCountField(harness, "ender_eye");
  const item = bot.entities[DROP_ID]!;
  delete bot.entities[DROP_ID];
  createMovements(bot); // Install the runtime inventory observer before measuring pickup cleanup.
  const inventoryListeners = bot.inventory.listenerCount("updateSlot");
  const addDrop = () => { bot.entities[item.id] = item; bot.emit("itemDrop", item); };
  // The pickup as the server sends it: the entity goes and the slot update (`updateSlot`) raises the count.
  const collect = () => { delete bot.entities[item.id]; eyes.count += 1; };
  return { bot, clock, item, addDrop, collect, inventoryListeners, count: () => eyes.count };
}
const endpoint = new Vec3(12, 72, 0);

test("recovers delayed native item metadata and requires inventory gain", async () => {
  const f = fixture();
  using _installed = f.clock.install();
  let routes = 0;
  const nav = { navigate: async () => {
    routes++; f.collect(); return { status: "completed", elapsedMs: 1 };
  } } as unknown as NavigationRuntime;
  const work = recoverEyeDrop(f.bot, nav, endpoint);
  f.addDrop();
  assert.deepEqual(await f.clock.settle(work, 20_000), { kind: "collected" });
  assert.equal(routes, 1);
  assert.equal(f.count(), 16);
  assert.equal(f.bot.listenerCount("itemDrop"), 0);
  assert.equal(f.bot.inventory.listenerCount("updateSlot"), f.inventoryListeners);
});

test("a shattered eye or unrelated distant drop does not start a route", async () => {
  const f = fixture();
  using _installed = f.clock.install();
  f.item.position = new Vec3(28, 64, 0); f.addDrop();
  const nav = { navigate: async () => { assert.fail("No matching drop exists."); } } as unknown as NavigationRuntime;
  assert.equal(await f.clock.settle(recoverEyeDrop(f.bot, nav, endpoint), 20_000), undefined);
  assert.equal(f.count(), 15);
  assert.equal(f.bot.listenerCount("itemDrop"), 0);
});

test("unreachable eye recovery returns without claiming inventory gain", async () => {
  const f = fixture(); f.addDrop();
  using _installed = f.clock.install();
  const nav = { navigate: async () => ({ status: "stopped", reason: "no safe path", elapsedMs: 1 }) } as unknown as NavigationRuntime;
  assert.equal((await f.clock.settle(recoverEyeDrop(f.bot, nav, endpoint), 20_000))?.kind, "not_collected");
  assert.equal(f.count(), 15);
});

test("cancellation releases pickup ownership and a later attempt can recover the same drop", async () => {
  const f = fixture(); f.addDrop(); const stop = new AbortController();
  using _installed = f.clock.install();
  const nav = { navigate: async ({ signal }: { signal: AbortSignal }) => {
    stop.abort(new Error("reflex takeover")); signal.throwIfAborted();
  } } as unknown as NavigationRuntime;
  await assert.rejects(f.clock.settle(recoverEyeDrop(f.bot, nav, endpoint, stop.signal), 20_000), /reflex takeover/);
  assert.equal(f.bot.inventory.listenerCount("updateSlot"), f.inventoryListeners);
  assert.equal(f.count(), 15);
  const resumed = { navigate: async () => { f.collect(); return { status: "completed", elapsedMs: 1 }; } } as unknown as NavigationRuntime;
  assert.equal((await f.clock.settle(recoverEyeDrop(f.bot, resumed, endpoint), 20_000))?.kind, "collected");
  assert.equal(f.count(), 16);
});
