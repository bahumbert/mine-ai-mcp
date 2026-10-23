/** `placeBlock` ends on the cell's `blockUpdate`: the held block is in the cell, and the server takes one from the stack. */
import assert from "node:assert/strict";
import { Vec3 } from "vec3";
import type { ContractCheck } from "../checks.ts";
import { holdsWithin, settleWithin } from "../subject.ts";

/** The floor block placed on, two blocks east of the feet, and the cell above it that receives the block. */
const REFERENCE = [2, -61, 0] as const;
const UP = new Vec3(0, 1, 0);
/** Mineflayer's own placement wait is 5 s; a server on time answers in a tick or two. */
const PLACEMENT_WALL_MS = 6_000;
const SLOT_WALL_MS = 2_000;

export const placementBlockUpdate: ContractCheck = {
  name: "placement-block-update",
  fixture: { cells: {}, carried: { cobblestone: 4 }, position: [0.5, -60, 0.5] },
  async run(subject) {
    const { bot } = subject;
    const reference = subject.world(REFERENCE);
    const destination = reference.plus(UP);
    const updates: string[] = [];
    const onUpdate = (_before: unknown, after: { name: string } | null) => void updates.push(after?.name ?? "null");
    bot.on(`blockUpdate:${destination}` as "blockUpdate:(x, y, z)", onUpdate);
    try {
      const settled = await settleWithin(subject, bot.placeBlock(bot.blockAt(reference)!, UP), PLACEMENT_WALL_MS);
      assert.ok(settled !== null && settled.error === undefined, `placeBlock: ${settled?.error?.message ?? "never ended"}`);
    } finally {
      bot.off(`blockUpdate:${destination}` as "blockUpdate:(x, y, z)", onUpdate);
    }
    assert.deepEqual(updates, ["cobblestone"], "one blockUpdate, to the placed block");
    assert.equal(bot.blockAt(destination)?.name, "cobblestone");
    const cobblestone = bot.registry.itemsByName.cobblestone!.id;
    assert.ok(await holdsWithin(subject, () => bot.inventory.count(cobblestone, null) === 3, SLOT_WALL_MS), `carried ${bot.inventory.count(cobblestone, null)} cobblestone after the placement: 3`);
  },
};
