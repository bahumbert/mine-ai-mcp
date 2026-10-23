/**
 * A chest within reach opens with `open_window` then `window_items` (63 slots, `minecraft:generic_9x3`, id 1 then 2);
 * withdraw and deposit are clicks the server applies, sending nothing back; the player's part of the window reaches
 * `bot.inventory` at the close, and the chest keeps its stacks for the next opening; a click on the closed window is
 * ignored; a chest 7.5 blocks away never opens (1.21.4, 2026-10-23).
 */
import assert from "node:assert/strict";
import { Vec3 } from "vec3";
import type { ContractCheck } from "../checks.ts";
import { settleWithin } from "../subject.ts";
import { recordWindowPackets, slotsOf } from "../window-packets.ts";

const SERVER_ANSWER_MS = 1_000;
const OPEN_WALL_MS = 5_000;
const FAR_WAIT_MS = 3_000;
/** In reach of a bot at x -4.5, and 7.5 blocks away from it. */
const NEAR = new Vec3(0, -60, 0);
const FAR = new Vec3(3, -60, 0);
const CHEST_SLOTS = [0, 1, 2, 3];
/** The bot's first main slot (9) as the chest window numbers it. */
const WINDOW_FIRST_MAIN_SLOT = 27;
/** Its last slot, the hotbar's ninth. */
const WINDOW_LAST_SLOT = 62;
const CHEST_TITLE = '{"type":"compound","value":{"translate":{"type":"string","value":"container.chest"}}}';

export const chestOpenTakeClose: ContractCheck = {
  name: "chest-open-take-close",
  // Bare bot: our runtime manages the inventory and would act on the windows.
  withoutRuntime: true,
  fixture: {
    cells: { "0,-60,0": "chest", "3,-60,0": "chest" },
    carried: { bread: 4 },
    containers: { "0,-60,0": { cobblestone: 70, torch: 3 }, "3,-60,0": { dirt: 5 } },
    position: [-4.5, -60, 0.5],
  },
  async run(subject) {
    const { bot, wait } = subject;
    const recording = recordWindowPackets(bot);
    const opened = await settleWithin(subject, bot.openContainer(bot.blockAt(NEAR)!), OPEN_WALL_MS);
    assert.ok(opened?.value !== undefined, `the chest in reach opened: ${opened?.error?.message ?? "never"}`);
    const window = opened.value;
    assert.deepEqual([window.type, window.id, window.slots.length], ["minecraft:generic_9x3", 1, 63]);
    assert.equal(JSON.stringify(window.title), CHEST_TITLE, "the title is the translation key as NBT");
    assert.deepEqual(slotsOf(window, CHEST_SLOTS), { 0: "cobblestone x64", 1: "cobblestone x6", 2: "torch x3", 3: null });
    assert.deepEqual(recording.packets.splice(0), [{ name: "open_window", windowId: 1 }, { name: "window_items", windowId: 1 }], "open_window, then the window's items");

    await window.withdraw(bot.registry.itemsByName.cobblestone!.id, null, 4);
    await wait(SERVER_ANSWER_MS);
    assert.deepEqual(slotsOf(window, CHEST_SLOTS), { 0: "cobblestone x2", 1: "cobblestone x64", 2: "torch x3", 3: null }, "Mineflayer's transfer: the 64 picked up, 4 put down one by one, the rest merged into the 6 and the 2 left in slot 0");
    assert.equal(slotsOf(window, [WINDOW_FIRST_MAIN_SLOT])[WINDOW_FIRST_MAIN_SLOT], "cobblestone x4", "in the first free slot of the window's player part");
    assert.equal(slotsOf(bot.inventory, [36])[36], "bread x4", "bot.inventory itself is untouched until the close");
    await window.deposit(bot.registry.itemsByName.bread!.id, null, 3);
    await wait(SERVER_ANSWER_MS);
    assert.deepEqual(slotsOf(window, CHEST_SLOTS), { 0: "cobblestone x2", 1: "cobblestone x64", 2: "torch x3", 3: "bread x3" });
    assert.deepEqual(recording.packets.splice(0), [], "the server's result is the client's: nothing is sent back");

    window.close();
    await wait(SERVER_ANSWER_MS);
    assert.equal(bot.currentWindow, null);
    assert.deepEqual(slotsOf(bot.inventory, [9, 10, 36]), { 9: "cobblestone x4", 10: "bread x1", 36: null }, "the window's player part is now the inventory");
    assert.deepEqual(recording.packets.splice(0), [], "the close brings no packet");

    const again = await settleWithin(subject, bot.openContainer(bot.blockAt(NEAR)!), OPEN_WALL_MS);
    assert.ok(again?.value !== undefined, `the chest opened again: ${again?.error?.message ?? "never"}`);
    assert.equal(again.value.id, 2, "the second window has the next id");
    assert.deepEqual(slotsOf(again.value, CHEST_SLOTS), { 0: "cobblestone x2", 1: "cobblestone x64", 2: "torch x3", 3: "bread x3" }, "the server kept the chest's stacks");
    // A shift click on a chest slot sends the stack to the last free slot of the window's player part, a bit of a stack it can join first.
    await bot.clickWindow(2, 0, 1);
    await wait(SERVER_ANSWER_MS);
    assert.deepEqual(slotsOf(again.value, [2, WINDOW_LAST_SLOT]), { 2: null, [WINDOW_LAST_SLOT]: "torch x3" }, "the chest's torches went to the end of the player's part");
    again.value.close();
    await wait(SERVER_ANSWER_MS);
    recording.packets.splice(0);
    bot._client.write("window_click", { windowId: 2, stateId: 0, slot: 0, mouseButton: 0, mode: 0, changedSlots: [], cursorItem: { itemCount: 0 } });
    await wait(SERVER_ANSWER_MS);
    assert.deepEqual(recording.packets.splice(0), [], "a click on the closed window is ignored");

    const far = await settleWithin(subject, bot.openContainer(bot.blockAt(FAR)!), FAR_WAIT_MS);
    recording.stop();
    assert.equal(far, null, "a chest out of reach never opens: the call stays pending");
    assert.deepEqual(recording.packets, [], "and nothing comes back");
  },
};
