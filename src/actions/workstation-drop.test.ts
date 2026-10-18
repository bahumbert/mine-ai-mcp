import assert from "node:assert/strict";
import { EventEmitter, getEventListeners } from "node:events";
import test from "node:test";
import { Vec3 } from "vec3";
import type { Bot } from "mineflayer";
import type { MovementPolicy, NavigationRuntime } from "../navigation/index.js";
import {
  recoverWorkstationDrop,
  REAL_DROP_CLOCK,
  WORKSTATION_DROP_SPAWN_WAIT_MS,
  type DropClock,
} from "./workstation-drop.js";

const source = { x: 1, y: 64, z: 0 };

function fixture() {
  let time = 0;
  const pending: Array<() => void> = [];
  const inventory = Object.assign(new EventEmitter(), { slots: [] as { name: string; count: number }[] });
  (inventory as unknown as { items: () => unknown[] }).items = () => inventory.slots;
  (inventory as unknown as { emptySlotCount: () => number }).emptySlotCount = () => 10;
  const entities: Record<number, unknown> = {};
  const bot = { inventory, entities, entity: { position: new Vec3(0, 64, 0) } } as unknown as Bot;
  // Sleeping steps the hand clock and runs what is due at that time (the late spawn).
  const clock: DropClock = {
    now: () => time,
    sleep: async (ms) => {
      time += ms;
      for (const act of pending.splice(0)) act();
    },
  };
  const spawnAt = (ms: number) => {
    const spawn = () => {
      entities[7] = {
        id: 7,
        name: "item",
        position: new Vec3(source.x + 0.5, 64, source.z + 0.5),
        width: 0.25,
        height: 0.25,
        getDroppedItem: () => ({ name: "crafting_table" }),
      };
    };
    const poll = () => {
      if (time >= ms) spawn();
      else pending.push(poll);
    };
    pending.push(poll);
  };
  const walks: number[] = [];
  const navigation = {
    navigate: async () => {
      walks.push(time);
      delete entities[7];
      inventory.slots.push({ name: "crafting_table", count: 1 });
      inventory.emit("updateSlot");
      return { status: "completed", elapsedMs: 1 };
    },
  } as unknown as NavigationRuntime;
  const movements = {} as MovementPolicy;
  return { bot, clock, spawnAt, navigation, movements, walks, entities, inventory, time: () => time };
}

test("a drop that spawns 3 s late is waited for, walked onto and collected", async () => {
  const f = fixture();
  f.spawnAt(3_000);
  const result = await recoverWorkstationDrop(f.bot, f.navigation, "crafting_table", source, 0, {}, {
    clock: f.clock,
    movements: f.movements,
  });
  assert.equal(result.status, "succeeded");
  assert.equal(f.walks.length, 1);
  assert.ok(f.walks[0]! >= 3_000 && f.walks[0]! < WORKSTATION_DROP_SPAWN_WAIT_MS);
});

test("a drop that never spawns fails within the bound, naming the spawn wait", async () => {
  const f = fixture();
  const result = await recoverWorkstationDrop(f.bot, f.navigation, "crafting_table", source, 0, {}, {
    clock: f.clock,
    movements: f.movements,
  });
  assert.equal(result.status, "failed");
  assert.match(result.status === "failed" ? result.error : "", /never appeared.*drop spawn wait/);
  assert.equal(f.walks.length, 0);
  assert.ok(f.time() <= WORKSTATION_DROP_SPAWN_WAIT_MS + 100);
});

test("a drop seen but not collected fails naming the pickup walk", async () => {
  const f = fixture();
  f.spawnAt(0);
  const stuck = {
    navigate: async () => ({ status: "stopped", reason: "no_path", elapsedMs: 1 }),
  } as unknown as NavigationRuntime;
  const result = await recoverWorkstationDrop(f.bot, stuck, "crafting_table", source, 0, {}, {
    clock: f.clock,
    movements: f.movements,
  });
  assert.equal(result.status, "failed");
  assert.match(result.status === "failed" ? result.error : "", /seen but not picked up.*drop pickup walk/);
});

test("the next recovery after a failed one collects a drop that has arrived since", async () => {
  const f = fixture();
  const first = await recoverWorkstationDrop(f.bot, f.navigation, "crafting_table", source, 0, {}, {
    clock: f.clock,
    movements: f.movements,
  });
  assert.equal(first.status, "failed");
  f.spawnAt(f.time());
  const second = await recoverWorkstationDrop(f.bot, f.navigation, "crafting_table", source, 0, {}, {
    clock: f.clock,
    movements: f.movements,
  });
  assert.equal(second.status, "succeeded");
});

test("an inventory that already gained the item needs no wait", async () => {
  const f = fixture();
  f.inventory.slots.push({ name: "crafting_table", count: 1 });
  const result = await recoverWorkstationDrop(f.bot, f.navigation, "crafting_table", source, 0, {}, {
    clock: f.clock,
    movements: f.movements,
  });
  assert.equal(result.status, "succeeded");
  assert.equal(f.time(), 0);
});

test("the real clock's sleep leaves no listener on the signal, and a cancel mid-wait rejects at once", async () => {
  const controller = new AbortController();
  for (let i = 0; i < 5; i += 1) await REAL_DROP_CLOCK.sleep(1, controller.signal);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  const waiting = REAL_DROP_CLOCK.sleep(60_000, controller.signal);
  assert.equal(getEventListeners(controller.signal, "abort").length, 1);
  controller.abort(new Error("cancelled"));
  await assert.rejects(waiting, /cancelled/);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});
