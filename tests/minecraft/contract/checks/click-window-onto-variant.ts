/**
 * A left click that puts a renamed stack onto a plain stack of its item is a swap on the server (the two stacks never
 * merge), while Prismarine's prediction merges them by `nbt`, which a 1.21.4 stack does not have. The server corrects
 * the slot with `set_slot` and the cursor with `set_cursor_item`, a packet Mineflayer has no handler for: the client's
 * cursor stays empty while the server's holds the plain stack, and the next click lands with that stack in hand
 * (1.21.4, 2026-10-23). `clickWindow` resolves when the click is written, not when the server answers.
 */
import assert from "node:assert/strict";
import type { ContractCheck } from "../checks.ts";
import { settleWithin } from "../subject.ts";
import { recordWindowPackets, variantStackOf } from "../window-packets.ts";

const SERVER_ANSWER_MS = 1_000;
const OPEN_WALL_MS = 5_000;
/** The chest's cell in the fixture's frame; `subject.world` moves it to the lane. */
const CHEST = [0, -60, 0] as const;
const RENAMED_SLOT = 0;
const PLAIN_SLOT = 1;
const WINDOW_ID = 1;
const CURSOR_ID = -1;

export const clickWindowOntoVariant: ContractCheck = {
  name: "click-window-onto-variant",
  // Bare bot: our runtime manages windows and would act on this one.
  withoutRuntime: true,
  fixture: {
    cells: { "0,-60,0": "chest" },
    carried: {},
    containers: { "0,-60,0": { renamed_first_cobblestone: 5, cobblestone: 4 } },
    position: [-4.5, -60, 0.5],
  },
  async run(subject) {
    const { bot, wait } = subject;
    const opened = await settleWithin(subject, bot.openContainer(bot.blockAt(subject.world(CHEST))!), OPEN_WALL_MS);
    assert.ok(opened?.value !== undefined, `the chest opened: ${opened?.error?.message ?? "never"}`);
    const window = opened.value;
    const recording = recordWindowPackets(bot);
    const seen = () => ({ renamedSlot: variantStackOf(window.slots[RENAMED_SLOT]), plainSlot: variantStackOf(window.slots[PLAIN_SLOT]), cursor: variantStackOf(window.selectedItem) });
    const RENAMED = 'cobblestone x5 "first"';

    await bot.clickWindow(RENAMED_SLOT, 0, 0);
    await wait(SERVER_ANSWER_MS);
    assert.deepEqual(seen(), { renamedSlot: null, plainSlot: "cobblestone x4", cursor: RENAMED }, "the renamed stack is on the cursor, on both sides");
    assert.deepEqual(recording.packets.splice(0), [], "the server agreed: nothing is sent back");

    await bot.clickWindow(PLAIN_SLOT, 0, 0);
    assert.deepEqual(seen(), { renamedSlot: null, plainSlot: "cobblestone x9", cursor: null }, "Prismarine predicts a merge: nbt is null on both");
    await wait(SERVER_ANSWER_MS);
    assert.deepEqual(seen(), { renamedSlot: null, plainSlot: RENAMED, cursor: null }, "the server swapped: the renamed stack lies in the slot; the client's cursor stays empty");
    assert.deepEqual(
      recording.packets.splice(0),
      [{ name: "set_slot", windowId: WINDOW_ID, slot: PLAIN_SLOT }, { name: "set_cursor_item", windowId: CURSOR_ID }],
      "the slot is corrected by set_slot and the cursor by set_cursor_item, which Mineflayer does not read",
    );

    await bot.clickWindow(RENAMED_SLOT, 0, 0);
    assert.deepEqual(seen(), { renamedSlot: null, plainSlot: RENAMED, cursor: null }, "the client sees a click on an empty slot with an empty hand: nothing");
    await wait(SERVER_ANSWER_MS);
    recording.stop();
    assert.deepEqual(seen(), { renamedSlot: "cobblestone x4", plainSlot: RENAMED, cursor: null }, "the server put the plain stack it still held in the emptied slot");
    assert.deepEqual(recording.packets, [{ name: "set_slot", windowId: WINDOW_ID, slot: RENAMED_SLOT }], "and told the slot only: its cursor is empty now, as the client believes");
    window.close();
  },
};
