/** `inventory.items()` is the non-empty slots 9-44; given stacks fill the hotbar first, split at the stack size. */
import assert from "node:assert/strict";
import type { ContractCheck } from "../checks.ts";

/** The player window's main inventory and hotbar (`prismarine-windows`): armour and off hand are outside. */
const FIRST_SLOT = 9;
const LAST_SLOT = 44;
const HOTBAR_START = 36;

export const itemsMatchSlots: ContractCheck = {
  name: "items-match-slots",
  fixture: { cells: {}, carried: { cobblestone: 70, oak_log: 3 }, position: [0.5, -60, 0.5] },
  async run({ bot }) {
    const { slots } = bot.inventory;
    const filled = slots.slice(FIRST_SLOT, LAST_SLOT + 1).filter((item) => item != null);
    assert.deepEqual(
      bot.inventory.items().map((item) => [item.slot, item.name, item.count]),
      filled.map((item) => [item.slot, item.name, item.count]),
    );
    assert.deepEqual(
      [HOTBAR_START, HOTBAR_START + 1, HOTBAR_START + 2].map((slot) => [slots[slot]?.name, slots[slot]?.count]),
      [["cobblestone", 64], ["cobblestone", 6], ["oak_log", 3]],
    );
    assert.equal(bot.inventory.count(bot.registry.itemsByName.cobblestone!.id, null), 70);
    assert.equal(bot.inventory.emptySlotCount(), 36 - 3);
    assert.equal(bot.heldItem?.name, "cobblestone", "the selected hotbar slot 0 holds the first stack");
  },
};
