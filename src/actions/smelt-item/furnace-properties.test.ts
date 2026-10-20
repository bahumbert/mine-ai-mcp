// A furnace just reopened by a resumed smelt: what it is doing is read from the raw window packets, not from mineflayer's derived fields.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Bot } from "mineflayer";
import { burningItems, furnaceObservation, settleBurnReport, type FurnaceWindow } from "./furnace-cook.js";
import { openFurnaceWithProperties, type FurnaceProperties } from "./furnace-properties.js";

type Packet = { readonly windowId: number; readonly property: number; readonly value: number };

/** A bot whose client plays `packets` while the window is opening, as the server sends them right behind the open. */
function openingBot(packets: readonly Packet[], options: { readonly fails?: boolean } = {}) {
  const client = new EventEmitter();
  const window = Object.assign(new EventEmitter(), {
    id: 5,
    inputItem: () => null, fuelItem: () => null, outputItem: () => null,
    // What mineflayer leaves on a window that lost the packets of the burst.
    fuel: 0, progress: null as number | null,
  });
  const bot = {
    _client: client,
    openFurnace: async () => {
      for (const packet of packets) client.emit("craft_progress_bar", packet);
      if (options.fails) throw new Error("window did not open");
      return window;
    },
  };
  return { bot: bot as unknown as Bot, client };
}

const propertiesOf = (window: FurnaceWindow) => (window as FurnaceWindow & { properties: () => FurnaceProperties | null }).properties();

test("the packets sent before the window was handed over are kept, and the lit time counts whole items", async () => {
  const { bot } = openingBot([{ windowId: 5, property: 0, value: 1_360 }, { windowId: 5, property: 1, value: 1_600 }]);
  const window = await openFurnaceWithProperties(bot, {} as never);
  assert.deepEqual(propertiesOf(window), { litTicks: 1_360, litTotalTicks: 1_600, cookTicks: 0, cookTotalTicks: 0 });
  assert.equal(burningItems(window), 6, "68 s of flame cook six 10 s items");
});

test("only the packets of this window count, and a later packet replaces an earlier one", async () => {
  const { bot, client } = openingBot([
    { windowId: 9, property: 0, value: 4_000 },
    { windowId: 5, property: 2, value: 40 },
    { windowId: 5, property: 3, value: 200 },
    { windowId: 5, property: 0, value: 1_000 },
  ]);
  const window = await openFurnaceWithProperties(bot, {} as never);
  client.emit("craft_progress_bar", { windowId: 5, property: 0, value: 200 });
  assert.deepEqual(propertiesOf(window), { litTicks: 200, litTotalTicks: 0, cookTicks: 40, cookTotalTicks: 200 });
});

test("a window that has heard nothing reports null and counts no fuel", async () => {
  const { bot } = openingBot([]);
  const window = await openFurnaceWithProperties(bot, {} as never);
  assert.equal(propertiesOf(window), null);
  assert.equal(burningItems(window), 0);
});

test("the observation reads the server's counters when mineflayer's derived fields lost a packet", async () => {
  // Mineflayer here: fuel 0 and progress null although the furnace is lit and cooking (the live SMELT_FUEL_STARVED).
  const { bot } = openingBot([
    { windowId: 5, property: 0, value: 800 }, { windowId: 5, property: 1, value: 1_600 },
    { windowId: 5, property: 2, value: 50 }, { windowId: 5, property: 3, value: 200 },
  ]);
  const window = await openFurnaceWithProperties(bot, {} as never);
  assert.equal(furnaceObservation(window).fuelProgress, 0.5);
  assert.equal(furnaceObservation(window).cookProgress, 0.25);
});

test("an unlit furnace that never cooked reads 0 and 0, not a division by zero", async () => {
  const { bot } = openingBot([{ windowId: 5, property: 0, value: 0 }]);
  const window = await openFurnaceWithProperties(bot, {} as never);
  assert.equal(furnaceObservation(window).fuelProgress, 0);
  assert.equal(furnaceObservation(window).cookProgress, 0);
});

test("the client listener is removed when the window closes and when it fails to open", async () => {
  const closing = openingBot([]);
  const window = await openFurnaceWithProperties(closing.bot, {} as never);
  assert.equal(closing.client.listenerCount("craft_progress_bar"), 1);
  (window as unknown as EventEmitter).emit("close");
  assert.equal(closing.client.listenerCount("craft_progress_bar"), 0);
  const failing = openingBot([], { fails: true });
  await assert.rejects(openFurnaceWithProperties(failing.bot, {} as never), /did not open/);
  assert.equal(failing.client.listenerCount("craft_progress_bar"), 0);
});

/** A clock whose pause plays the scripted server: `at` ms after the start, run `act`. */
function scriptedClock(script: readonly { readonly at: number; readonly act: () => void }[]) {
  let now = 0;
  const pending = [...script];
  return {
    now: () => now,
    pause: async (milliseconds: number) => {
      now += milliseconds;
      while (pending.length > 0 && pending[0]!.at <= now) pending.shift()!.act();
    },
  };
}

test("the settle waits for the first report and then reads it", async () => {
  let said: FurnaceProperties | null = null;
  const window = { properties: () => said } as unknown as FurnaceWindow;
  const clock = scriptedClock([{ at: 150, act: () => { said = { litTicks: 600, litTotalTicks: 1_600, cookTicks: 0, cookTotalTicks: 200 }; } }]);
  await settleBurnReport(window, clock);
  assert.equal(clock.now(), 150);
  assert.equal(burningItems(window), 3);
});

test("a window that never reports is waited for up to the bound and counts no fuel", async () => {
  const window = { properties: () => null } as unknown as FurnaceWindow;
  const clock = scriptedClock([]);
  await settleBurnReport(window, clock);
  assert.equal(clock.now(), 500);
  assert.equal(burningItems(window), 0);
});

test("a window with no properties (a test double) is not waited for", async () => {
  const clock = scriptedClock([]);
  await settleBurnReport({} as unknown as FurnaceWindow, clock);
  assert.equal(clock.now(), 0);
});
