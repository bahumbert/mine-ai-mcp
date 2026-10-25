/**
 * A shield in the off hand raised with a use of the off hand (Mine Labs 1.21.4, 2026-10-23, 3 runs): the bot's living-entity
 * flags (metadata) hold the hand-in-use bit and the off-hand bit while it is up (3), and only the off-hand bit after it is
 * lowered (2: the bit stays). The client's `usingHeldItem` follows its own calls.
 */
import assert from "node:assert/strict";
import type { ContractCheck } from "../checks.ts";
import { answerArrives } from "../server-answer.ts";
import { useFlagsOf } from "./combat-scene.ts";

const USING_HAND = 1;
const OFF_HAND = 2;

export const shieldRaised: ContractCheck = {
  name: "shield-raised",
  fixture: { cells: {}, carried: { shield: 1 }, position: [0.5, -60, 0.5] },
  withoutRuntime: true,
  async run(subject) {
    const { bot } = subject;
    const shield = bot.inventory.items().find((stack) => stack.name === "shield")!;
    await bot.equip(shield, "off-hand");
    await answerArrives(subject, () => bot.inventory.slots[45]?.name === "shield", "the shield is not in the off hand");
    assert.equal(useFlagsOf(bot) & USING_HAND, 0);
    bot.activateItem(true);
    assert.equal(bot.usingHeldItem, true);
    // The flags come with the server's tick of the use; the bits are asserted once they have.
    await answerArrives(subject, () => useFlagsOf(bot) === (USING_HAND | OFF_HAND), "the raised shield's flags");
    assert.equal(useFlagsOf(bot), USING_HAND | OFF_HAND, "a raised shield does not set both bits");
    bot.deactivateItem();
    assert.equal(bot.usingHeldItem, false);
    await answerArrives(subject, () => useFlagsOf(bot) === OFF_HAND, "the lowered shield's flags");
    assert.equal(useFlagsOf(bot), OFF_HAND, "a lowered shield leaves another state than the off-hand bit");
    assert.equal(bot.inventory.slots[45]?.name, "shield", "the shield left the off hand");
  },
};
