/** `equip` into the hand selects the stack's hotbar slot; into the off hand moves it to slot 45; the server keeps both. */
import assert from "node:assert/strict";
import type { ContractCheck } from "../checks.ts";
import { serverQuiet } from "../server-answer.ts";

const OFF_HAND_SLOT = 45;

export const equipHandAndOffHand: ContractCheck = {
  name: "equip-hand-and-off-hand",
  fixture: { cells: {}, carried: { cobblestone: 10, torch: 5 }, position: [0.5, -60, 0.5] },
  async run(subject) {
    const { bot } = subject;
    const torch = () => bot.inventory.items().find((item) => item.name === "torch");
    // A server that disagreed sends the slots back within its ticks: the reads below wait for them, not for a wall time.
    await bot.equip(torch()!, "hand");
    await serverQuiet(subject, "after the equip in the hand");
    assert.equal(bot.quickBarSlot, 1, "the torch's hotbar slot (37) is selected");
    assert.equal(bot.heldItem?.name, "torch");
    await bot.equip(torch()!, "off-hand");
    await serverQuiet(subject, "after the equip in the off hand");
    const offHand = bot.inventory.slots[OFF_HAND_SLOT];
    assert.deepEqual([offHand?.name, offHand?.count], ["torch", 5], "slot 45 holds the torches");
    assert.equal(bot.inventory.slots[37], null, "the torches left slot 37");
    assert.equal(torch(), undefined, "items() leaves the off hand out");
  },
};
