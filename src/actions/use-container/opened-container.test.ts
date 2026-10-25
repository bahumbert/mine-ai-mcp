import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot, stackText } from "../../test-support/fake-bot/index.js";
import { SERVER_ANSWER_TICKS } from "../../world/world-age.js";
import { CLICK_WALL_MS } from "./window-answer.js";
import { OpenedContainer } from "./opened-container.js";

const CELL = "1,64,1";

/** The bot beside a chest at CELL holding `stacks` (names of items or of `ITEM_VARIANTS`, by slot); the waits under test read the harness clock. */
function chest(stacks: readonly { slot: number; name: string; count: number }[]) {
  const harness = createFakeBot({ position: new Vec3(0, 64, 0), cells: { [CELL]: "chest" }, containers: { [CELL]: {} } });
  harness.windows.setContainerStacks(CELL, stacks);
  return {
    ...harness,
    open: () => harness.clock.settle(OpenedContainer.open(harness.bot, harness.bot.blockAt(new Vec3(1, 64, 1))!, harness.clock), 5_000),
    age: () => harness.bot.time.age,
    cursor: () => stackText(harness.bot.currentWindow?.selectedItem),
    slot: (index: number) => stackText(harness.bot.currentWindow?.slots[index]),
  };
}

test("a click that puts a stack on another stack of its variant ends when the world has moved 40 ticks and the server sent nothing: the prediction stands", async () => {
  const { clock, age, cursor, slot, open } = chest([{ slot: 0, name: "renamed_first_cobblestone", count: 5 }, { slot: 1, name: "renamed_first_cobblestone", count: 7 }]);
  const container = await open();
  await container.clickStack(0);
  const sentAt = age();
  await clock.settle(container.clickStack(1), CLICK_WALL_MS * 2);
  assert.ok(age() - sentAt >= SERVER_ANSWER_TICKS, `waited ${age() - sentAt} ticks`);
  assert.deepEqual([cursor(), slot(0), slot(1)], [null, null, 'cobblestone x12 "first"']);
});

test("a click onto a stack of another variant waits the 40 ticks too, and the cursor the server sends is the one the bot reads", async () => {
  const { clock, age, cursor, slot, open } = chest([{ slot: 0, name: "renamed_first_cobblestone", count: 5 }, { slot: 1, name: "cobblestone", count: 4 }]);
  const container = await open();
  await container.clickStack(0);
  const sentAt = age();
  await clock.settle(container.clickStack(1), CLICK_WALL_MS * 2);
  assert.ok(age() - sentAt >= SERVER_ANSWER_TICKS, `the correction ended the wait after ${age() - sentAt} ticks: the answer is the world age, not the first packet`);
  assert.deepEqual([cursor(), slot(0), slot(1)], ["cobblestone x4", null, 'cobblestone x5 "first"'], "Mineflayer drops set_cursor_item: the container applies it, so the cursor reads the server's plain stack");
});

test("a click on an empty slot or on a stack of another item waits for nothing", async () => {
  const { clock, age, open } = chest([{ slot: 0, name: "renamed_first_cobblestone", count: 5 }, { slot: 1, name: "oak_planks", count: 4 }]);
  const container = await open();
  await container.clickStack(0);
  const sentAt = age();
  await clock.settle(container.clickStack(1), CLICK_WALL_MS);
  await clock.settle(container.clickStack(2), CLICK_WALL_MS);
  assert.ok(age() - sentAt < SERVER_ANSWER_TICKS, `waited ${age() - sentAt} ticks`);
});

test("a server whose world age stands still fails the click on the wall clock, naming the slot and what to do", async () => {
  const { clock, server, open } = chest([{ slot: 0, name: "renamed_first_cobblestone", count: 5 }, { slot: 1, name: "renamed_first_cobblestone", count: 7 }]);
  const container = await open();
  await container.clickStack(0);
  server.stop();
  await assert.rejects(clock.settle(container.clickStack(1), CLICK_WALL_MS * 2), /did not answer the click on slot 1: the world age did not move for 5 s.*Reopen/s);
});

test("an aborted wait stops listening for the server's packets", async () => {
  const { clock, bot, server, open } = chest([{ slot: 0, name: "renamed_first_cobblestone", count: 5 }, { slot: 1, name: "renamed_first_cobblestone", count: 7 }]);
  const container = await open();
  const before = ["set_slot", "window_items", "set_cursor_item"].map((name) => bot._client.listenerCount(name));
  await container.clickStack(0);
  server.stop();
  const controller = new AbortController();
  const waiting = container.clickStack(1, controller.signal);
  await clock.advance(200);
  controller.abort(new Error("stopped"));
  await assert.rejects(clock.settle(waiting, 1_000), /stopped/);
  assert.deepEqual(["set_slot", "window_items", "set_cursor_item"].map((name) => bot._client.listenerCount(name)), before);
});
