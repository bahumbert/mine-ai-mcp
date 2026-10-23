/**
 * A tossed stack is not picked up again for 40 ticks (the pickup delay the server gives a player's toss, Mine Labs
 * 2026-10-23): the bot walled in so that the drop lands at its feet, the toss comes back into the inventory only after the
 * delay, in one `collect`, the server having merged the items it spawned for the right clicks of a part of a stack.
 */
import assert from "node:assert/strict";
import type { Entity } from "prismarine-entity";
import type { ContractCheck } from "../checks.ts";
import { holdsWithin } from "../subject.ts";

const TOSSED = 3;
const TOSS_PICKUP_DELAY_TICKS = 40;
const MS_PER_TICK = 50;
/** Measured over 7 runs (Mine Labs 2026-10-23): 1939-1997 ms from the first spawn the client sees to the collect for 40 ticks (2000 ms); the bounds leave 250 ms under and 500 ms over. */
const EARLIEST_PICKUP_MS = TOSS_PICKUP_DELAY_TICKS * MS_PER_TICK - 250;
const LATEST_PICKUP_MS = TOSS_PICKUP_DELAY_TICKS * MS_PER_TICK + 500;
/** A stone ring one block out, two high: a toss in any direction lands within reach of the feet. */
const RING = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
const WALLED_IN = Object.fromEntries([-60, -59].flatMap((y) => RING.map(([x, z]) => [`${x},${y},${z}`, "stone"] as const)));

export const tossedItemKeptBeforeDelay: ContractCheck = {
  name: "tossed-item-kept-before-delay",
  // Bare bot: our runtime must not walk to the tossed stack while the check measures the server (review of T3b-C).
  withoutRuntime: true,
  fixture: { cells: WALLED_IN, carried: { cobblestone: 10 }, position: [0.5, -60, 0.5] },
  async run(subject) {
    const { bot } = subject;
    const cobblestone = bot.registry.itemsByName.cobblestone!.id;
    let firstSpawnMs: number | null = null;
    let collectedAtMs: number | null = null;
    const onSpawn = (entity: Entity) => {
      if (entity.name === "item") firstSpawnMs ??= subject.now();
    };
    const onCollect = () => void (collectedAtMs ??= subject.now());
    bot.on("entitySpawn", onSpawn);
    bot.on("playerCollect", onCollect);
    try {
      await bot.toss(cobblestone, null, TOSSED);
      assert.ok(await holdsWithin(subject, () => collectedAtMs !== null, LATEST_PICKUP_MS + 1_000), "the tossed stack never came back");
    } finally {
      bot.off("entitySpawn", onSpawn);
      bot.off("playerCollect", onCollect);
    }
    const afterMs = collectedAtMs! - firstSpawnMs!;
    assert.ok(afterMs >= EARLIEST_PICKUP_MS && afterMs <= LATEST_PICKUP_MS, `the toss came back ${afterMs} ms after its spawn, delay ${TOSS_PICKUP_DELAY_TICKS} ticks: not within ${EARLIEST_PICKUP_MS}-${LATEST_PICKUP_MS}`);
    assert.equal(bot.inventory.count(cobblestone, null), 10, "everything tossed came back");
  },
};
