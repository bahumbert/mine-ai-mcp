import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import type { WindowsExports } from "prismarine-windows";
import { temporaryBotData } from "../test-support/bot-data.js";
import { createFakeBot, createFakeClock, itemOf } from "../test-support/fake-bot/index.js";
import { captureStderr } from "../test-support/stderr.js";
import { observeBotStatus } from "./bot-status.js";

const require = createRequire(import.meta.url);
/** Prismarine's windows for a version, as Mineflayer opens them; its typings miss the loader's call signature. */
const loadWindows = require("prismarine-windows") as (version: string) => WindowsExports;

/** A bot whose clock drives the status writer's coalescing timer and heartbeat. */
function fixture() {
  const clock = createFakeClock({ mode: "mocked", startMs: Date.parse("2026-10-21T00:00:00.000Z") });
  return createFakeBot({ username: "StreamBot", clock });
}

/** An emitter as a listener count reads it: Node's, or Mineflayer's typed one. */
type Listened = { eventNames(): Array<string | symbol>; listenerCount(event: string | symbol): number };
/** How many listeners each event has: what an observer that detaches everything leaves unchanged. */
function listenerCounts(emitter: Listened): Record<string, number> {
  return Object.fromEntries(emitter.eventNames().map((name) => [String(name), emitter.listenerCount(name)]));
}

test("SQL follows pickups, held equipment, open-container transfers and empty inventory without tool calls", async t => {
  const data = temporaryBotData({ closeAfter: t });
  const { bot, clock, inventory } = fixture();
  using _timers = clock.install();
  const stop = observeBotStatus(bot, data);
  t.after(stop);
  inventory.updateSlot(36, itemOf(bot.registry, "oak_log", 3));
  inventory.updateSlot(5, itemOf(bot.registry, "iron_helmet"));
  await clock.advance(300);
  const rows = () => data.read("SELECT slot, item_name, count, held FROM bot_inventory ORDER BY slot");
  assert.deepEqual(rows(), [
    { slot: 5, item_name: "iron_helmet", count: 1, held: 0 },
    { slot: 36, item_name: "oak_log", count: 3, held: 1 },
  ]);
  // A chest's own window: its carried slots start at 27, so its slot 54 is the hotbar's first.
  const chest = loadWindows(bot.version).createWindow(1, "minecraft:generic_9x3", "Chest");
  chest.updateSlot(54, itemOf(bot.registry, "diamond", 2));
  bot.currentWindow = chest;
  bot.emit("windowOpen", chest);
  await clock.advance(300);
  assert.deepEqual(rows()[1], { slot: 36, item_name: "diamond", count: 2, held: 1 });
  chest.updateSlot(54, itemOf(bot.registry, "diamond", 1));
  inventory.setQuickBarSlot(1);
  await clock.advance(300);
  assert.deepEqual(rows()[1], { slot: 36, item_name: "diamond", count: 1, held: 0 });
  bot.currentWindow = null;
  // Prismarine's typings forget that a slot the server empties takes null.
  inventory.updateSlot(36, null as never);
  inventory.updateSlot(5, null as never);
  bot.emit("windowClose", chest);
  bot.emit("respawn");
  await clock.advance(300);
  assert.deepEqual(rows(), []);
  assert.equal(listenerCounts(chest).updateSlot ?? 0, 0);
  assert.equal(data.read("SELECT bot_id FROM bot_status")[0]?.bot_id, "StreamBot");
});

test("heartbeat refreshes idle status, and disconnect cancels queued work before SQL closes", async t => {
  const data = temporaryBotData({ closeAfter: t });
  const stderr = captureStderr(t);
  const { bot, clock, inventory } = fixture();
  using _timers = clock.install();
  const listenersBefore = { bot: listenerCounts(bot), inventory: listenerCounts(inventory) };
  const stop = observeBotStatus(bot, data);
  await clock.advance(300);
  const first = data.read("SELECT updated_at FROM bot_status")[0]?.updated_at;
  await clock.advance(1_050);
  assert.notEqual(data.read("SELECT updated_at FROM bot_status")[0]?.updated_at, first);
  inventory.updateSlot(36, itemOf(bot.registry, "oak_log"));
  bot.emit("end", "socketClosed");
  stop();
  stop();
  assert.deepEqual({ bot: listenerCounts(bot), inventory: listenerCounts(inventory) }, listenersBefore);
  data.close();
  await clock.advance(300);
  assert.deepEqual(stderr, [], "no queued write reached the closed store");
});

test("a failing status refresh logs each distinct error once and the next heartbeat recovers", async t => {
  const data = temporaryBotData({ closeAfter: t });
  const stderr = captureStderr(t);
  const { bot, clock } = fixture();
  using _timers = clock.install();
  const failing = t.mock.method(data, "transaction", () => { throw new Error("database is locked"); });
  const stop = observeBotStatus(bot, data);
  t.after(stop);
  await clock.advance(300);
  await clock.advance(1_050);
  assert.ok(failing.mock.callCount() >= 2, "the heartbeat retried");
  assert.deepEqual(stderr, ["[bot-status] database is locked\n"]);
  failing.mock.restore();
  await clock.advance(1_050);
  assert.equal(data.read("SELECT bot_id FROM bot_status")[0]?.bot_id, "StreamBot");
});
