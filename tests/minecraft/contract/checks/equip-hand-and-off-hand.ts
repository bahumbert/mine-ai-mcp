/** `equip` into the hand selects the stack's hotbar slot; into the off hand moves it to slot 45; the server keeps both. */
import assert from "node:assert/strict";
import type { ContractCheck } from "../checks.ts";

const OFF_HAND_SLOT = 45;
/** Long enough for a server that disagreed to send the slots back. */
const SERVER_ANSWER_MS = 1_000;

export const equipHandAndOffHand: ContractCheck = {
  name: "equip-hand-and-off-hand",
  fixture: { cells: {}, carried: { cobblestone: 10, torch: 5 }, position: [0.5, -60, 0.5] },
  async run({ bot, wait }) {
    const torch = () => bot.inventory.items().find((item) => item.name === "torch");
    await bot.equip(torch()!, "hand");
    await wait(SERVER_ANSWER_MS);
    assert.equal(bot.quickBarSlot, 1, "the torch's hotbar slot (37) is selected");
    assert.equal(bot.heldItem?.name, "torch");
    await bot.equip(torch()!, "off-hand");
    await wait(SERVER_ANSWER_MS);
    const offHand = bot.inventory.slots[OFF_HAND_SLOT];
    assert.deepEqual([offHand?.name, offHand?.count], ["torch", 5], "slot 45 holds the torches");
    assert.equal(bot.inventory.slots[37], null, "the torches left slot 37");
    assert.equal(torch(), undefined, "items() leaves the off hand out");
  },
};
