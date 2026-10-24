/**
 * A tossed stack is not picked up again for 40 ticks (the pickup delay the server gives a player's toss, Mine Labs
 * 2026-10-23): the bot walled in so that the drop lands at its feet, the toss comes back into the inventory only after the
 * delay, in one `collect`, the server having merged the items it spawned for the right clicks of a part of a stack.
 *
 * The delay is judged by the server's ticks, each read with `time query gametime` sent right before the toss and right at the collect
 * the client hears: a lane's server that stalls while another lane arranges (E4) holds fewer ticks in a wall gap and runs the owed ones
 * back to back, and a server behind its schedule holds 40 ticks in more than 2 s (facts `live-testing.md`, "Ticks between two acts on lanes").
 * The collect is read after the server took it and the client heard it, so its reading is never early and may be late: the toss comes
 * back never before the delay (less the readings' own error), and late only within the wait's wall bound.
 */
import assert from "node:assert/strict";
import type { ContractCheck } from "../checks.ts";
import { ANSWER_WALL_MS } from "../server-answer.ts";
import { holdsWithin } from "../subject.ts";
import { TICK_MS } from "./combat-scene.ts";
import { type Mark, READING_TICKS, markNow, tickOf } from "./server-tick-marks.ts";

const TOSSED = 3;
const TOSS_PICKUP_DELAY_TICKS = 40;
/** A reading sent right before the toss is the toss's own tick to within `READING_TICKS`; the collect's, sent when the client heard it, is the pickup's tick or later. */
const EARLIEST_PICKUP_TICKS = TOSS_PICKUP_DELAY_TICKS - READING_TICKS;
/** Late is the client's lag, not the game: the readings may differ by the ticks the wait's wall bound holds on a server on time. */
const LATEST_PICKUP_TICKS = TOSS_PICKUP_DELAY_TICKS + ANSWER_WALL_MS / TICK_MS;
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
    let collected: Mark | null = null;
    const onCollect = () => void (collected ??= markNow(subject));
    bot.on("playerCollect", onCollect);
    let tossed: Mark;
    try {
      tossed = markNow(subject);
      await bot.toss(cobblestone, null, TOSSED);
      assert.ok(await holdsWithin(subject, () => collected !== null, ANSWER_WALL_MS), "the tossed stack never came back");
    } finally {
      bot.off("playerCollect", onCollect);
    }
    const tossTick = await tickOf(subject, tossed);
    const collectTick = await tickOf(subject, collected!);
    const afterTicks = collectTick - tossTick;
    assert.ok(
      afterTicks >= EARLIEST_PICKUP_TICKS && afterTicks <= LATEST_PICKUP_TICKS,
      `the toss came back at server tick ${collectTick}, ${afterTicks} ticks after the toss at tick ${tossTick} (${Math.round(collected!.atMs - tossed.atMs)} ms apart by the client): the delay is ${TOSS_PICKUP_DELAY_TICKS} ticks, not less than ${EARLIEST_PICKUP_TICKS} (readings +-${READING_TICKS}) and not more than ${LATEST_PICKUP_TICKS}`,
    );
    assert.equal(bot.inventory.count(cobblestone, null), 10, "everything tossed came back");
  },
};
