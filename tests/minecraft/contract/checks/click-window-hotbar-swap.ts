/**
 * A number-key click swaps the clicked slot with the hotbar slot and the server, which makes the same swap, sends
 * nothing back (1.21.4, 2026-10-23); a click carrying a state id the server does not hold is applied all the same, and
 * the server answers it with one `window_items` of the whole player window and the cursor.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { Item } from "prismarine-item";
import type { ContractCheck } from "../checks.ts";
import { answerSettled, serverQuiet } from "../server-answer.ts";
import { recordWindowPackets, slotsOf } from "../window-packets.ts";

const MAIN_SLOT = 9;
const HOTBAR_SLOT = 36;
/** Ten stacks fill the hotbar (36-44) and then slot 9, as `give` does. */
const CARRIED = { cobblestone: 3, dirt: 3, torch: 3, stick: 3, oak_planks: 3, bread: 3, apple: 3, coal: 3, iron_ingot: 3, gold_ingot: 3 };
const SWAPPED = { [MAIN_SLOT]: "cobblestone x3", [HOTBAR_SLOT]: "gold_ingot x3" };

export const clickWindowHotbarSwap: ContractCheck = {
  name: "click-window-hotbar-swap",
  // Bare bot: our runtime manages the inventory and would act on the windows.
  withoutRuntime: true,
  fixture: { cells: {}, carried: CARRIED, position: [0.5, -60, 0.5] },
  async run(subject) {
    const { bot } = subject;
    assert.deepEqual(slotsOf(bot.inventory, [MAIN_SLOT, HOTBAR_SLOT]), { [MAIN_SLOT]: "gold_ingot x3", [HOTBAR_SLOT]: "cobblestone x3" });
    const recording = recordWindowPackets(bot);
    await bot.clickWindow(MAIN_SLOT, 0, 2);
    assert.deepEqual(slotsOf(bot.inventory, [MAIN_SLOT, HOTBAR_SLOT]), SWAPPED, "the client predicts the swap");
    await serverQuiet(subject, "after the swap click");
    assert.deepEqual(slotsOf(bot.inventory, [MAIN_SLOT, HOTBAR_SLOT]), SWAPPED, "and the server keeps it");
    assert.deepEqual(recording.packets, [], "the server's swap is the client's: nothing is sent back");
    // A click whose state id is stale: Mineflayer's own resync is a no-op click with state id -1.
    const ItemClass = (createRequire(import.meta.url)("prismarine-item") as (registry: typeof bot.registry) => typeof Item)(bot.registry);
    bot._client.write("window_click", { windowId: 0, stateId: -1, slot: MAIN_SLOT, mouseButton: 0, mode: 0, changedSlots: [], cursorItem: ItemClass.toNotch(null) });
    await answerSettled(subject, () => recording.packets.length > 0, "the whole-window answer to the stale click");
    recording.stop();
    assert.deepEqual(recording.packets, [{ name: "window_items", windowId: 0 }], "one whole-window answer");
    assert.deepEqual(slotsOf(bot.inventory, [MAIN_SLOT, HOTBAR_SLOT]), { [MAIN_SLOT]: null, [HOTBAR_SLOT]: "gold_ingot x3" }, "the stale click was applied: the stack was picked up");
    assert.equal(bot.inventory.selectedItem?.name, "cobblestone", "and the server's cursor came with the window");
  },
};
