/**
 * `placeBlock` ends on the cell's `blockUpdate`: the held block is in the cell, and the server takes one from the stack.
 * The cell's `blockUpdate` comes twice, both to the placed block, in one server tick (Mine Labs 1.21.4, 2026-10-24, 10 of
 * 10 runs on the shared server): the server sends the change twice (the chunk's and the click's resend) and Mineflayer
 * emits an update for each packet, the second with a state the cell already has (`blocks.js` `updateBlockState`,
 * prismarine-world `_emitBlockUpdate`). Whether the second arrives before `placeBlock` ends depends on the read, so
 * the updates are counted until the server has run its ticks of an absence after it ended (`serverQuiet`).
 */
import assert from "node:assert/strict";
import { Vec3 } from "vec3";
import type { ContractCheck } from "../checks.ts";
import { answerArrives, serverQuiet } from "../server-answer.ts";
import { settleWithin } from "../subject.ts";

/** The floor block placed on, two blocks east of the feet, and the cell above it that receives the block. */
const REFERENCE = [2, -61, 0] as const;
const UP = new Vec3(0, 1, 0);
/** Mineflayer's own placement wait is 5 s (a client timer); a server on time answers in a tick or two. */
const PLACEMENT_WALL_MS = 6_000;

export const placementBlockUpdate: ContractCheck = {
  name: "placement-block-update",
  fixture: { cells: {}, carried: { cobblestone: 4 }, position: [0.5, -60, 0.5] },
  async run(subject) {
    const { bot } = subject;
    const reference = subject.world(REFERENCE);
    const destination = reference.plus(UP);
    const updates: { name: string; age: number }[] = [];
    const onUpdate = (_before: unknown, after: { name: string } | null) => void updates.push({ name: after?.name ?? "null", age: bot.time.age });
    bot.on(`blockUpdate:${destination}` as "blockUpdate:(x, y, z)", onUpdate);
    try {
      const startAge = bot.time.age;
      const settled = await settleWithin(subject, bot.placeBlock(bot.blockAt(reference)!, UP), PLACEMENT_WALL_MS);
      assert.ok(settled !== null && settled.error === undefined, `placeBlock: ${settled?.error?.message ?? "never ended"}`);
      const settledAge = bot.time.age;
      await serverQuiet(subject, "the cell's updates after placeBlock ended");
      const timeline = updates.map(({ name, age }) => `${name} at +${age - startAge}`).join(", ");
      assert.deepEqual(updates.map(({ name }) => name), ["cobblestone", "cobblestone"], `blockUpdates of the cell (placeBlock ended at +${settledAge - startAge} ticks): ${timeline}`);
    } finally {
      bot.off(`blockUpdate:${destination}` as "blockUpdate:(x, y, z)", onUpdate);
    }
    assert.equal(bot.blockAt(destination)?.name, "cobblestone");
    const cobblestone = bot.registry.itemsByName.cobblestone!.id;
    await answerArrives(subject, () => bot.inventory.count(cobblestone, null) === 3, "the stack of 4 cobblestone did not drop to 3 after the placement");
  },
};
