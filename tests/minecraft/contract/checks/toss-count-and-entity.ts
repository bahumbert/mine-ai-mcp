/**
 * A toss lowers the count as soon as `toss` returns (Mineflayer's click prediction, `inventory.js:643-650`, review #32),
 * then the server spawns item entities holding the tossed items: one per right click for a part of a stack (Mineflayer's
 * `transfer`; 3 spawns of 1 on the server, 2026-10-21), which it merges on its own clock, so the check sums them.
 */
import assert from "node:assert/strict";
import type { Entity } from "prismarine-entity";
import type { ContractCheck } from "../checks.ts";
import { ANSWER_WALL_MS } from "../server-answer.ts";
import { holdsWithin } from "../subject.ts";

const TOSSED = 3;
/** The drop starts at the eye and falls in front of the bot: well inside this. */
const DROP_REACH = 4;

export const tossCountAndEntity: ContractCheck = {
  name: "toss-count-and-entity",
  // The fixture keeps 3 blocks clear around the bot (no hopper or wall to catch the drop).
  fixture: { cells: {}, carried: { cobblestone: 10 }, position: [0.5, -60, 0.5] },
  async run(subject) {
    const { bot } = subject;
    const cobblestone = bot.registry.itemsByName.cobblestone!.id;
    const spawned: Entity[] = [];
    const onSpawn = (entity: Entity) => {
      if (entity.name === "item") spawned.push(entity);
    };
    bot.on("entitySpawn", onSpawn);
    try {
      await bot.toss(cobblestone, null, TOSSED);
      assert.equal(bot.inventory.count(cobblestone, null), 10 - TOSSED, "the count is lowered once toss returns");
      // Live drops only: a merge removes the absorbed entity from `bot.entities` and raises the other's count.
      const droppedCount = () =>
        spawned
          .filter((entity) => bot.entities[entity.id] === entity && entity.position.distanceTo(bot.entity.position) <= DROP_REACH)
          .reduce((total, entity) => total + (entity.getDroppedItem()?.name === "cobblestone" ? entity.getDroppedItem()!.count : 0), 0);
      assert.ok(await holdsWithin(subject, () => droppedCount() === TOSSED, ANSWER_WALL_MS), `${droppedCount()} cobblestone in live item entities within ${ANSWER_WALL_MS} ms, not ${TOSSED} (${spawned.length} item spawns)`);
    } finally {
      bot.off("entitySpawn", onSpawn);
    }
    assert.equal(bot.inventory.count(cobblestone, null), 10 - TOSSED, "the server kept the lowered count");
  },
};
