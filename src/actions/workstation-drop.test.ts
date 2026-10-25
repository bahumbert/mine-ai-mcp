import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { Vec3 } from "vec3";
import type { MovementPolicy, NavigationRuntime } from "../navigation/index.js";
import { createFakeBot, createFakeClock, itemOf } from "../test-support/fake-bot/index.js";
import {
  recoverWorkstationDrop,
  REAL_DROP_CLOCK,
  WORKSTATION_DROP_SPAWN_WAIT_MS,
} from "./workstation-drop.js";

const source = { x: 1, y: 64, z: 0 };

/**
 * The harness on a mocked clock: the clock is the action's `DropClock`, and the pickup's settle timers (global
 * `setTimeout`) move with it. Install it with `using _installed = f.clock.install()` in the test.
 */
function fixture() {
  const clock = createFakeClock({ mode: "mocked" });
  const harness = createFakeBot({
    clock,
    position: new Vec3(0, 64, 0),
    entities: { 7: { name: "item", position: new Vec3(source.x + 0.5, 64, source.z + 0.5), getDroppedItem: () => tableItem() } },
  });
  const { bot, inventory } = harness;
  const tableItem = () => itemOf(bot.registry, "crafting_table", 1);
  // The drop is made by the harness and kept out of the bot's sight until the server spawns it.
  const drop = bot.entities[7]!;
  delete bot.entities[7];
  const spawnAt = (ms: number) => {
    clock.after(Math.max(0, ms - clock.now()), () => {
      bot.entities[7] = drop;
    });
  };
  const walks: number[] = [];
  const navigation = {
    navigate: async () => {
      walks.push(clock.now());
      delete bot.entities[7];
      inventory.updateSlot(36, tableItem());
      return { status: "completed", elapsedMs: 1 };
    },
  } as unknown as NavigationRuntime;
  const movements = {} as MovementPolicy;
  return { bot, clock, spawnAt, navigation, movements, walks, inventory, tableItem, time: () => clock.now() };
}

test("a drop that spawns 3 s late is waited for, walked onto and collected", async () => {
  const f = fixture();
  using _installed = f.clock.install();
  f.spawnAt(3_000);
  const result = await f.clock.settle(recoverWorkstationDrop(f.bot, f.navigation, "crafting_table", source, 0, {}, {
    clock: f.clock,
    movements: f.movements,
  }), 60_000);
  assert.equal(result.status, "succeeded");
  assert.equal(f.walks.length, 1);
  assert.ok(f.walks[0]! >= 3_000 && f.walks[0]! < WORKSTATION_DROP_SPAWN_WAIT_MS);
});

test("a drop that never spawns fails within the bound, naming the spawn wait", async () => {
  const f = fixture();
  using _installed = f.clock.install();
  const result = await f.clock.settle(recoverWorkstationDrop(f.bot, f.navigation, "crafting_table", source, 0, {}, {
    clock: f.clock,
    movements: f.movements,
  }), 60_000);
  assert.equal(result.status, "failed");
  assert.match(result.status === "failed" ? result.error : "", /never appeared.*drop spawn wait/);
  assert.equal(f.walks.length, 0);
  assert.ok(f.time() <= WORKSTATION_DROP_SPAWN_WAIT_MS + 100);
});

test("a drop seen but not collected fails naming the pickup walk", async () => {
  const f = fixture();
  using _installed = f.clock.install();
  f.spawnAt(0);
  const stuck = {
    navigate: async () => ({ status: "stopped", reason: "no_path", elapsedMs: 1 }),
  } as unknown as NavigationRuntime;
  const result = await f.clock.settle(recoverWorkstationDrop(f.bot, stuck, "crafting_table", source, 0, {}, {
    clock: f.clock,
    movements: f.movements,
  }), 60_000);
  assert.equal(result.status, "failed");
  assert.match(result.status === "failed" ? result.error : "", /seen but not picked up.*drop pickup walk/);
});

test("the next recovery after a failed one collects a drop that has arrived since", async () => {
  const f = fixture();
  using _installed = f.clock.install();
  const first = await f.clock.settle(recoverWorkstationDrop(f.bot, f.navigation, "crafting_table", source, 0, {}, {
    clock: f.clock,
    movements: f.movements,
  }), 60_000);
  assert.equal(first.status, "failed");
  f.spawnAt(f.time());
  const second = await f.clock.settle(recoverWorkstationDrop(f.bot, f.navigation, "crafting_table", source, 0, {}, {
    clock: f.clock,
    movements: f.movements,
  }), 60_000);
  assert.equal(second.status, "succeeded");
});

test("an inventory that already gained the item needs no wait", async () => {
  const f = fixture();
  using _installed = f.clock.install();
  f.inventory.updateSlot(36, f.tableItem());
  const result = await f.clock.settle(recoverWorkstationDrop(f.bot, f.navigation, "crafting_table", source, 0, {}, {
    clock: f.clock,
    movements: f.movements,
  }), 60_000);
  assert.equal(result.status, "succeeded");
  assert.equal(f.time(), 0);
});

test("the real clock's sleep leaves no listener on the signal, and a cancel mid-wait rejects at once", async () => {
  // The real clock reads the global timers: a mocked clock moves them, so its 1 ms sleeps end on an advance.
  const clock = createFakeClock({ mode: "mocked" });
  using _installed = clock.install();
  const controller = new AbortController();
  for (let i = 0; i < 5; i += 1) await clock.settle(REAL_DROP_CLOCK.sleep(1, controller.signal), 1_000);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  const waiting = REAL_DROP_CLOCK.sleep(60_000, controller.signal);
  assert.equal(getEventListeners(controller.signal, "abort").length, 1);
  controller.abort(new Error("cancelled"));
  await assert.rejects(waiting, /cancelled/);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});
