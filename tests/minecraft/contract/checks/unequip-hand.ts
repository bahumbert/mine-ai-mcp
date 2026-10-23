/**
 * `unequip("hand")` is Mineflayer's own (`simple_inventory.js:43-79`) on a server that keeps what it is told (Mine Labs 1.21.4,
 * 2026-10-23, 3 runs): with a free hotbar slot it selects it (`held_item_slot`) and moves nothing; with the hotbar full it
 * clicks the held stack into a free main slot, the selected slot staying. The server's inventory then agrees.
 */
import assert from "node:assert/strict";
import type { ContractCheck } from "../checks.ts";
import type { ContractBot } from "../subject.ts";
import { countWrites } from "./bed-scene.ts";
import { CALL_WALL_MS, finishWithin } from "./combat-scene.ts";

const SETTLE_MS = 500;
const FIRST_MAIN_SLOT = 9;
const FIRST_HOTBAR_SLOT = 36;
/** Nine stacks, so the hotbar is full (the join gives it first). */
const HOTBAR_FULL = { stone: 1, dirt: 1, cobblestone: 1, oak_planks: 1, sand: 1, gravel: 1, glass: 1, torch: 1, bricks: 1 };

/** The name of the stack in the hand (read through a call: an earlier assertion narrows `bot.heldItem`). */
const heldName = (bot: ContractBot) => bot.heldItem?.name;

export const unequipHand: ContractCheck = {
  name: "unequip-hand",
  fixture: { cells: {}, carried: HOTBAR_FULL, position: [0.5, -60, 0.5] },
  withoutRuntime: true,
  async run(subject) {
    const { bot } = subject;
    const selects = countWrites(bot, "held_item_slot");
    try {
      assert.equal(heldName(bot), "stone");
      await finishWithin(subject, bot.unequip("hand"), CALL_WALL_MS, "unequip");
      await subject.wait(SETTLE_MS);
      assert.equal(heldName(bot), undefined, "a full hotbar: the hand is not empty");
      assert.equal(bot.quickBarSlot, 0, "a full hotbar: the selected slot moved");
      assert.equal(bot.inventory.slots[FIRST_MAIN_SLOT]?.name, "stone", "a full hotbar: the stack is not in the first free main slot");
      assert.equal(selects.count(), 0, "a full hotbar: a slot was selected");

      await finishWithin(subject, bot.unequip("hand"), CALL_WALL_MS, "unequip");
      assert.equal(bot.quickBarSlot, 0, "an empty hand moved the selection");
      assert.equal(selects.count(), 0, "an empty hand selected a slot");

      await finishWithin(subject, bot.equip(bot.inventory.slots[FIRST_HOTBAR_SLOT + 1]!, "hand"), CALL_WALL_MS, "equip");
      assert.equal(heldName(bot), "dirt");
      assert.equal(bot.quickBarSlot, 1);
      await finishWithin(subject, bot.unequip("hand"), CALL_WALL_MS, "unequip");
      await subject.wait(SETTLE_MS);
      assert.equal(heldName(bot), undefined, "a free slot: the hand is not empty");
      assert.equal(bot.quickBarSlot, 0, "a free slot: the first free hotbar slot was not selected");
      assert.equal(bot.inventory.slots[FIRST_HOTBAR_SLOT + 1]?.name, "dirt", "a free slot: the held stack moved");
    } finally {
      selects.stop();
    }
  },
};
