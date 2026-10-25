import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot } from "./fake-bot.js";
import { stackText } from "./item-variants.js";

/** The packets the server sends the client, by name, in the order they arrive. */
function receivedFromServer(client: NodeJS.EventEmitter, names: readonly string[]) {
  const received: { readonly name: string; readonly packet: Record<string, unknown> }[] = [];
  for (const name of names) client.on(name, (packet: Record<string, unknown>) => void received.push({ name, packet }));
  return received;
}

/** A `window_click` as Mineflayer writes it, with the state id and window the test names (a no-op pick-up of nothing). */
function writeClick(bot: ReturnType<typeof createFakeBot>["bot"], click: { windowId: number; stateId: number; slot: number }): void {
  bot._client.write("window_click", { ...click, mouseButton: 0, mode: 0, changedSlots: [], cursorItem: { itemCount: 0 } });
}

/** An `openContainer` nobody answers: Mineflayer gives up after 20 s of wall time, long after the test, so the rejection is taken here. */
function openUnanswered(bot: ReturnType<typeof createFakeBot>["bot"], cell: Vec3): { readonly opened: boolean } {
  const state = { opened: false };
  void bot.openContainer(bot.blockAt(cell)!).then(() => void (state.opened = true), () => undefined);
  return state;
}

const CHEST = "3,64,0";
const CHEST_CELLS = { [CHEST]: "chest" } as const;
const BESIDE_THE_CHEST = new Vec3(1.5, 64, 0.5);

test("a number-key click swaps the slot with the hotbar slot: the client predicts it, the server writes the same and sends nothing back (inventory.js:603-706)", async () => {
  const { bot, clock, server } = createFakeBot({ slots: { 9: { name: "cobblestone", count: 5 }, 36: { name: "torch", count: 3 } } });
  const received = receivedFromServer(bot._client, ["set_slot", "window_items"]);
  await bot.clickWindow(9, 0, 2);
  assert.deepEqual([bot.inventory.slots[9]?.name, bot.inventory.slots[36]?.name], ["torch", "cobblestone"]);
  const click = server.packets.find(({ name }) => name === "window_click")?.data as Record<string, unknown>;
  assert.deepEqual({ windowId: click.windowId, slot: click.slot, mouseButton: click.mouseButton, mode: click.mode }, { windowId: 0, slot: 9, mouseButton: 0, mode: 2 });
  await clock.advance(1_000);
  assert.deepEqual(received, [], "the server's result is the client's: it corrects nothing");
});

test("a shift click on a hotbar stack: Prismarine's prediction drops it, the server moves it to the first free main slot and sends that one slot (contract click-window-shift-move)", async () => {
  const { bot, clock } = createFakeBot({ slots: { 36: { name: "torch", count: 3 } } });
  const received = receivedFromServer(bot._client, ["set_slot", "window_items"]);
  await bot.clickWindow(36, 0, 1);
  assert.deepEqual([bot.inventory.slots[36], bot.inventory.slots[9]], [null, null], "the client's own library has lost the stack");
  await clock.advance(1_000);
  assert.deepEqual(received.map(({ name, packet }) => [name, packet.slot]), [["set_slot", 9]]);
  assert.deepEqual([bot.inventory.slots[36], bot.inventory.slots[9]?.name, bot.inventory.slots[9]?.count], [null, "torch", 3]);
});

test("a shift click on a main slot fills the stack of the same item on the hotbar before any empty slot", async () => {
  const { bot, clock } = createFakeBot({ slots: { 9: { name: "torch", count: 3 }, 38: { name: "torch", count: 60 } } });
  await bot.clickWindow(9, 0, 1);
  await clock.advance(1_000);
  assert.deepEqual([bot.inventory.slots[9], bot.inventory.slots[38]?.count, bot.inventory.slots[36]], [null, 63, null]);
});

test("a click on a stack picks it up and a click on an empty slot puts it down; the cursor is the window's selected item", async () => {
  const { bot, clock } = createFakeBot({ slots: { 9: { name: "cobblestone", count: 5 } } });
  await bot.clickWindow(9, 0, 0);
  assert.equal(bot.inventory.selectedItem?.name, "cobblestone");
  await bot.clickWindow(10, 0, 0);
  await clock.advance(1_000);
  assert.deepEqual([bot.inventory.selectedItem, bot.inventory.slots[9], bot.inventory.slots[10]?.count], [null, null, 5]);
});

test("a click carrying a stateId the server does not hold is applied, and the whole window comes back with the server's state (contract click-window-hotbar-swap)", async () => {
  const { bot, clock } = createFakeBot({ slots: { 36: { name: "cobblestone", count: 5 } } });
  await bot.clickWindow(36, 0, 2); // the first window call: Mineflayer is listening, and knows the login's state id
  const received = receivedFromServer(bot._client, ["set_slot", "window_items"]);
  writeClick(bot, { windowId: 0, stateId: -1, slot: 36 });
  await clock.advance(1_000);
  assert.deepEqual(received.map(({ name, packet }) => [name, packet.windowId]), [["window_items", 0]]);
  assert.equal((received[0]!.packet.items as unknown[]).length, 46);
  assert.deepEqual([bot.inventory.slots[36], bot.inventory.selectedItem?.name], [null, "cobblestone"], "the server picked the stack up, as asked");
});

test("a click on a window id the server has not open is ignored", async () => {
  const { bot, clock } = createFakeBot({ slots: { 9: { name: "cobblestone", count: 5 } } });
  const received = receivedFromServer(bot._client, ["set_slot", "window_items"]);
  writeClick(bot, { windowId: 9, stateId: 0, slot: 9 });
  await clock.advance(1_000);
  assert.deepEqual(received, []);
});

test("a stopped server answers a stale click only once it runs again", async () => {
  const { bot, clock, server } = createFakeBot({ slots: { 9: { name: "cobblestone", count: 5 } } });
  const received = receivedFromServer(bot._client, ["window_items"]);
  server.stop();
  writeClick(bot, { windowId: 0, stateId: 77, slot: 9 });
  await clock.advance(2_000);
  assert.deepEqual(received, []);
  server.resume();
  await clock.advance(100);
  assert.equal(received.length, 1);
});

test("opening a chest: the server sends open_window then the window's items, and the bot's windowOpen follows (inventory.js:417-422)", async () => {
  const { bot, clock, windows } = createFakeBot({ position: BESIDE_THE_CHEST, cells: CHEST_CELLS, containers: { [CHEST]: { cobblestone: 70, torch: 3 } } });
  const received = receivedFromServer(bot._client, ["open_window", "window_items", "set_slot"]);
  const opening = bot.openContainer(bot.blockAt(new Vec3(3, 64, 0))!);
  const window = await clock.settle(opening, 5_000);
  assert.deepEqual(received.map(({ name }) => name), ["open_window", "window_items"]);
  assert.equal(window.type, "minecraft:generic_9x3");
  assert.equal(window.slots.length, 63);
  assert.deepEqual(window.containerItems().map(({ name, count, slot }) => [slot, name, count]), [[0, "cobblestone", 64], [1, "cobblestone", 6], [2, "torch", 3]]);
  assert.equal(bot.currentWindow, window);
  assert.equal(windows.openWindowId, window.id);
});

test("a chest's stacks move through the window: withdraw and deposit are Mineflayer's own clicks, and the chest keeps the result after the close", async () => {
  const { bot, clock, windows, server } = createFakeBot({
    position: BESIDE_THE_CHEST,
    cells: CHEST_CELLS,
    carried: { bread: 4 },
    containers: { [CHEST]: { cobblestone: 10 } },
  });
  const window = await clock.settle(bot.openContainer(bot.blockAt(new Vec3(3, 64, 0))!), 5_000);
  await clock.settle(window.withdraw(bot.registry.itemsByName.cobblestone!.id, null, 4), 5_000);
  await clock.settle(window.deposit(bot.registry.itemsByName.bread!.id, null, 3), 5_000);
  await clock.advance(500);
  assert.deepEqual(windows.containerStacks(CHEST), [{ slot: 0, name: "cobblestone", count: 6 }, { slot: 1, name: "bread", count: 3 }], "the server's chest follows the open window");
  window.close();
  await clock.advance(500);
  assert.equal(bot.currentWindow, null);
  assert.deepEqual(windows.containerStacks(CHEST), [{ slot: 0, name: "cobblestone", count: 6 }, { slot: 1, name: "bread", count: 3 }]);
  assert.equal(bot.inventory.count(bot.registry.itemsByName.cobblestone!.id, null), 4);
  assert.equal(bot.inventory.count(bot.registry.itemsByName.bread!.id, null), 1);
  assert.equal(server.packets.filter(({ name }) => name === "close_window").length, 1);
  assert.equal(windows.openWindowId, null);
});

test("a chest out of reach never opens: nothing comes back and the call stays pending", async () => {
  const { bot, clock, windows } = createFakeBot({ position: new Vec3(-5.5, 64, 0.5), cells: CHEST_CELLS, containers: { [CHEST]: { cobblestone: 1 } } });
  const received = receivedFromServer(bot._client, ["open_window", "window_items"]);
  const opening = openUnanswered(bot, new Vec3(3, 64, 0));
  await clock.advance(10_000);
  assert.deepEqual([opening.opened, received, windows.openWindowId, bot.currentWindow], [false, [], null, null]);
});

test("the open_window answer takes the server's lag", async () => {
  const { bot, clock } = createFakeBot({ position: BESIDE_THE_CHEST, cells: CHEST_CELLS, containers: { [CHEST]: { cobblestone: 1 } }, lagMs: 400 });
  const opening = bot.openContainer(bot.blockAt(new Vec3(3, 64, 0))!);
  await clock.advance(300);
  assert.equal(bot.currentWindow, null, "the server has not answered yet");
  const window = await clock.settle(opening, 5_000);
  assert.equal(window.type, "minecraft:generic_9x3");
});

test("a chest opened while a block is held opens: the held block is not placed against it", async () => {
  const { bot, clock, world } = createFakeBot({ position: BESIDE_THE_CHEST, cells: CHEST_CELLS, carried: { cobblestone: 5 }, containers: { [CHEST]: {} } });
  await bot.equip(bot.registry.itemsByName.cobblestone!.id, "hand");
  await clock.settle(bot.openContainer(bot.blockAt(new Vec3(3, 64, 0))!), 5_000);
  assert.equal(world.blockAt(new Vec3(3, 65, 0))?.name, "air");
  assert.equal(bot.inventory.count(bot.registry.itemsByName.cobblestone!.id, null), 5);
});

test("a chest in the cells without a containers entry opens empty, as setblock alone gives one, and the held block is not placed on it", async () => {
  const { bot, clock, world } = createFakeBot({ position: BESIDE_THE_CHEST, cells: CHEST_CELLS, carried: { cobblestone: 5 } });
  await bot.equip(bot.registry.itemsByName.cobblestone!.id, "hand");
  const window = await clock.settle(bot.openContainer(bot.blockAt(new Vec3(3, 64, 0))!), 5_000);
  assert.deepEqual([window.type, window.containerItems().length], ["minecraft:generic_9x3", 0]);
  assert.equal(world.blockAt(new Vec3(3, 65, 0))?.name, "air");
});

test("a click that would merge into a full stack moves nothing and the server sends nothing", async () => {
  const { bot, clock } = createFakeBot({ slots: { 9: { name: "cobblestone", count: 64 }, 10: { name: "cobblestone", count: 5 } } });
  const received = receivedFromServer(bot._client, ["set_slot", "window_items"]);
  await bot.clickWindow(10, 0, 0);
  await bot.clickWindow(9, 0, 0);
  await clock.advance(1_000);
  assert.deepEqual([bot.inventory.slots[9]?.count, bot.inventory.selectedItem?.count], [64, 5]);
  assert.deepEqual(received, []);
});

test("a container window open while the server is stopped keeps the client's prediction, and the server applies the click when it runs again", async () => {
  const { bot, clock, windows, server } = createFakeBot({ position: BESIDE_THE_CHEST, cells: CHEST_CELLS, containers: { [CHEST]: { cobblestone: 10 } } });
  const window = await clock.settle(bot.openContainer(bot.blockAt(new Vec3(3, 64, 0))!), 5_000);
  server.stop();
  await bot.clickWindow(0, 0, 0);
  await clock.advance(2_000);
  assert.deepEqual([window.slots[0], window.selectedItem?.count, windows.containerStacks(CHEST).length], [null, 10, 1], "the client lifted the stack, the server has not heard");
  server.resume();
  await clock.advance(100);
  assert.deepEqual(windows.containerStacks(CHEST), [], "the server lifted it too");
});

test("a shift click on a container slot goes to the end of the player's part of the window, and one on a player slot to the first free container slot", async () => {
  const { bot, clock } = createFakeBot({ position: BESIDE_THE_CHEST, cells: CHEST_CELLS, carried: { bread: 2 }, containers: { [CHEST]: { torch: 3 } } });
  const window = await clock.settle(bot.openContainer(bot.blockAt(new Vec3(3, 64, 0))!), 5_000);
  await bot.clickWindow(0, 0, 1);
  await clock.advance(1_000);
  assert.deepEqual([window.slots[0], window.slots[62]?.name], [null, "torch"]);
  await bot.clickWindow(62, 0, 1);
  await clock.advance(1_000);
  assert.deepEqual([window.slots[0]?.name, window.slots[62]], ["torch", null]);
});

/** A bot beside the chest, whose stacks are `containers` or, slot by slot, `stacks` (names of items or of `ITEM_VARIANTS`), its window open. */
async function openedChest(containers: Readonly<Record<string, number>>, carried: Readonly<Record<string, number>> = {}, stacks?: readonly { slot: number; name: string; count: number }[]) {
  const harness = createFakeBot({ position: BESIDE_THE_CHEST, cells: CHEST_CELLS, carried, containers: { [CHEST]: containers } });
  if (stacks !== undefined) harness.windows.setContainerStacks(CHEST, stacks);
  const window = await harness.clock.settle(harness.bot.openContainer(harness.bot.blockAt(new Vec3(3, 64, 0))!), 5_000);
  return { ...harness, window, received: receivedFromServer(harness.bot._client, ["set_slot", "set_cursor_item", "window_items"]) };
}

test("stacks of one variant merge on the server as they do on the client, and so do two plain stacks, with nothing sent back", async () => {
  const { bot, clock, window, received } = await openedChest({}, {}, [{ slot: 0, name: "renamed_first_cobblestone", count: 5 }, { slot: 1, name: "renamed_first_cobblestone", count: 7 }]);
  await bot.clickWindow(0, 0, 0);
  await bot.clickWindow(1, 0, 0);
  await clock.advance(1_000);
  assert.deepEqual([stackText(window.slots[0]), stackText(window.slots[1]), stackText(window.selectedItem), received], [null, 'cobblestone x12 "first"', null, []]);
  const plain = await openedChest({ cobblestone: 4 }, { cobblestone: 5 });
  await plain.bot.clickWindow(0, 0, 0);
  await plain.bot.clickWindow(54, 0, 0);
  await plain.clock.advance(1_000);
  assert.deepEqual([stackText(plain.window.slots[54]), plain.received], ["cobblestone x9", []]);
});

test("a right click halves a renamed stack into two renamed stacks on the server, and the client's halves become renamed once it answers", async () => {
  const { bot, clock, window } = await openedChest({ renamed_first_cobblestone: 5 });
  await bot.clickWindow(0, 1, 0);
  assert.deepEqual([stackText(window.slots[0]), stackText(window.selectedItem)], ['cobblestone x2 "first"', "cobblestone x3"], "Prismarine's split drops the components");
  await bot.clickWindow(5, 0, 0);
  await clock.advance(1_000);
  assert.deepEqual([stackText(window.slots[0]), stackText(window.slots[5])], ['cobblestone x2 "first"', 'cobblestone x3 "first"'], "the server's halves are both renamed");
  window.close();
  await clock.advance(500);
  const again = await clock.settle(bot.openContainer(bot.blockAt(new Vec3(3, 64, 0))!), 5_000);
  assert.deepEqual([stackText(again.slots[0]), stackText(again.slots[5])], ['cobblestone x2 "first"', 'cobblestone x3 "first"'], "and the chest keeps them so");
});

test("a right click that puts one renamed item down on an empty slot puts down a renamed item: Prismarine's put-down is plain until the server corrects the slot", async () => {
  const { bot, clock, window, received } = await openedChest({ renamed_first_cobblestone: 5 });
  await bot.clickWindow(0, 0, 0);
  await bot.clickWindow(3, 1, 0);
  assert.deepEqual([stackText(window.slots[3]), stackText(window.selectedItem)], ["cobblestone x1", 'cobblestone x4 "first"']);
  await clock.advance(1_000);
  assert.deepEqual([stackText(window.slots[3]), stackText(window.selectedItem)], ['cobblestone x1 "first"', 'cobblestone x4 "first"'], "the slot is corrected; the cursor was right");
  assert.deepEqual(received.map(({ name, packet }) => [name, packet.slot]), [["set_slot", 3]]);
});

test("a shift click of a renamed stack does not join a plain stack of its item in the other part of the window", async () => {
  const { bot, clock, window } = await openedChest({ renamed_first_cobblestone: 5 }, { cobblestone: 10 });
  await bot.clickWindow(0, 0, 1);
  await clock.advance(1_000);
  assert.deepEqual([stackText(window.slots[0]), stackText(window.slots[54]), stackText(window.slots[62])], [null, "cobblestone x10", 'cobblestone x5 "first"']);
});

test("the chest's stacks read back by the name a test gave them: a variant by its ITEM_VARIANTS name, a plain stack by its item's", () => {
  const { windows } = createFakeBot({ cells: CHEST_CELLS, containers: { [CHEST]: { renamed_first_cobblestone: 5, cobblestone: 4 } } });
  assert.deepEqual(windows.containerStacks(CHEST), [{ slot: 0, name: "renamed_first_cobblestone", count: 5 }, { slot: 1, name: "cobblestone", count: 4 }]);
  windows.setContainerStacks(CHEST, [{ slot: 2, name: "enchanted_cobblestone", count: 3 }]);
  assert.deepEqual(windows.containerStacks(CHEST), [{ slot: 2, name: "enchanted_cobblestone", count: 3 }], "set and read agree");
});

/** The inventory's stacks as `stackText` reads them, by player-window slot. */
function inventoryText(bot: ReturnType<typeof createFakeBot>["bot"]): Record<number, string> {
  return Object.fromEntries(bot.inventory.items().map((item) => [item.slot, stackText(item)!]));
}

test("a window closed with a stack in hand gives it to the inventory: a free slot (contract variant-transfer-clicks), else the ground (same check); the partial-stack join and the hotbar-first order are unmeasured", async () => {
  const joined = await openedChest({ renamed_first_cobblestone: 5 });
  await joined.bot.clickWindow(0, 0, 0);
  joined.window.close();
  await joined.clock.advance(500);
  assert.deepEqual(inventoryText(joined.bot), { 36: 'cobblestone x5 "first"' }, "a free slot, hotbar first");
  assert.deepEqual(joined.received.map(({ name, packet }) => [name, packet.windowId, packet.slot]), [["set_slot", 0, 36]], "answered with set_slot of the player window");

  const merging = await openedChest({ renamed_first_cobblestone: 5, cobblestone: 3 }, { cobblestone: 10, renamed_first_cobblestone: 20 });
  await merging.bot.clickWindow(0, 0, 0);
  merging.window.close();
  await merging.clock.advance(500);
  assert.deepEqual(inventoryText(merging.bot), { 36: "cobblestone x10", 37: 'cobblestone x25 "first"' }, "joined the renamed 20, not the plain 10");

  const full = await openedChest({ renamed_second_cobblestone: 3 }, Object.fromEntries(["dirt", "sand", "gravel", "stick", "coal", "bread", "apple", "carrot", "potato", "wheat", "sugar", "paper", "string", "feather", "flint", "bone", "leather", "brick", "torch", "stone", "granite", "diorite", "andesite", "clay", "ice", "snow", "cactus", "vine", "kelp", "melon", "pumpkin", "bamboo", "cake", "bowl", "slime_ball", "bucket"].map((name) => [name, 1])));
  await full.bot.clickWindow(0, 0, 0);
  full.window.close();
  await full.clock.advance(500);
  const dropped = Object.values(full.bot.entities).filter(({ name }) => name === "item");
  assert.deepEqual(dropped.map((entity) => stackText(entity.getDroppedItem())), ['cobblestone x3 "second"'], "a full inventory drops it as one item entity, renamed as it was");
  assert.equal(full.bot.inventory.items().length, 36, "and takes nothing");
});

test("onClickReceived runs as each click reaches the server, before it is applied; what it queues with server.answer lands after that click and before the next", async () => {
  const { bot, clock, windows, server } = await openedChest({ renamed_first_cobblestone: 5, cobblestone: 4 });
  const seen: string[] = [];
  const stop = windows.onClickReceived(({ slot, mouseButton, mode }) => {
    seen.push(`${slot}/${mouseButton}/${mode}`);
    if (seen.length === 1) server.answer(() => seen.push(`after the first: ${windows.containerStacks(CHEST).map((stack) => `${stack.slot}:${stack.name}x${stack.count}`).join(",")}`));
  });
  await bot.clickWindow(1, 0, 0);
  await bot.clickWindow(0, 0, 0);
  assert.deepEqual(seen, ["1/0/0", "0/0/0"], "both reached the server before it answered any");
  await clock.advance(500);
  assert.deepEqual(seen, ["1/0/0", "0/0/0", "after the first: 0:renamed_first_cobblestonex5"], "the queued change ran after the first click was applied and before the second");
  stop();
  await bot.clickWindow(5, 0, 0);
  assert.equal(seen.length, 3, "a removed listener hears nothing more");
});

test("closeOpenWindow is the server closing the window: close_window reaches the bot, which has no current window, and the stack in hand goes to the inventory", async () => {
  const { bot, clock, windows, window, server } = await openedChest({ renamed_first_cobblestone: 5 });
  await bot.clickWindow(0, 0, 0);
  await clock.advance(100); // the server has the click
  const closed: unknown[] = [];
  bot.on("windowClose", (closedWindow) => void closed.push(closedWindow));
  windows.closeOpenWindow();
  await clock.advance(500);
  assert.equal(bot.currentWindow, null);
  assert.deepEqual(closed, [window]);
  assert.equal(windows.openWindowId, null);
  assert.deepEqual(inventoryText(bot), { 36: 'cobblestone x5 "first"' });
  assert.equal(server.packets.filter(({ name }) => name === "close_window").length, 0, "the bot did not write a close itself");
});

test("another player changing the open chest reaches the open window as set_slot, and the chest keeps it after the close", async () => {
  const { bot, clock, windows, window } = await openedChest({ cobblestone: 4 });
  windows.setContainerStacks(CHEST, [{ slot: 0, name: "cobblestone", count: 4 }, { slot: 3, name: "renamed_first_cobblestone", count: 2 }]);
  await clock.advance(500);
  assert.deepEqual([stackText(window.slots[0]), stackText(window.slots[3])], ["cobblestone x4", 'cobblestone x2 "first"'], "the open window shows the other player's stack");
  await bot.clickWindow(3, 0, 0);
  await bot.clickWindow(5, 0, 0);
  await clock.advance(500);
  window.close();
  await clock.advance(500);
  assert.deepEqual(windows.containerStacks(CHEST), [{ slot: 0, name: "cobblestone", count: 4 }, { slot: 5, name: "renamed_first_cobblestone", count: 2 }]);
});
