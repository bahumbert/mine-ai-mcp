/**
 * A shift click moves a stack from the hotbar to the main slots, and from the main slots to the hotbar, merging into a
 * stack of the same item first. Prismarine's prediction of the first (`prismarine-windows` `shiftClick`) is wrong; the
 * server corrects it with a `set_slot` for each slot the claim got wrong (1.21.4, 2026-10-23).
 */
import assert from "node:assert/strict";
import type { ContractCheck } from "../checks.ts";
import { recordWindowPackets, slotsOf } from "../window-packets.ts";

const SERVER_ANSWER_MS = 1_000;
/** 64 dirt in slot 36, 6 in slot 37. */
const CARRIED = { dirt: 70 };
const WATCHED = [9, 10, 36, 37, 38];
const FIRST_MAIN_SLOT = 9;
const FIRST_HOTBAR_SLOT = 36;

export const clickWindowShiftMove: ContractCheck = {
  name: "click-window-shift-move",
  // Bare bot: our runtime manages the inventory and would act on the windows.
  withoutRuntime: true,
  fixture: { cells: {}, carried: CARRIED, position: [0.5, -60, 0.5] },
  async run({ bot, wait }) {
    const slots = () => slotsOf(bot.inventory, WATCHED);
    assert.deepEqual(slots(), { 9: null, 10: null, 36: "dirt x64", 37: "dirt x6", 38: null });
    const recording = recordWindowPackets(bot);
    await bot.clickWindow(FIRST_HOTBAR_SLOT, 0, 1);
    assert.deepEqual(slots(), { 9: "dirt x6", 10: null, 36: null, 37: "dirt x64", 38: null }, "Prismarine predicts the 64 merged into the 6 and the 6 moved to the first main slot");
    await wait(SERVER_ANSWER_MS);
    assert.deepEqual(slots(), { 9: "dirt x64", 10: null, 36: null, 37: "dirt x6", 38: null }, "the server moved the 64 to the first free main slot");
    assert.deepEqual(
      recording.packets.splice(0),
      [{ name: "set_slot", windowId: 0, slot: FIRST_MAIN_SLOT }, { name: "set_slot", windowId: 0, slot: 37 }],
      "and corrected the two slots the claim had wrong",
    );
    await bot.clickWindow(FIRST_MAIN_SLOT, 0, 1);
    await wait(SERVER_ANSWER_MS);
    recording.stop();
    assert.deepEqual(slots(), { 9: null, 10: null, 36: "dirt x6", 37: "dirt x64", 38: null }, "the 64 back on the hotbar: merged into the 6 (up to 64, 6 left over), the rest in the first free hotbar slot");
    assert.deepEqual(recording.packets, [], "the client had predicted that move right");
  },
};
