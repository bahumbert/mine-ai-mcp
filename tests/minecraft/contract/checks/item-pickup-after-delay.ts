/**
 * The server picks an item entity up once its pickup delay is over, it is in reach (the bot's box grown by 1 block
 * sideways and half a block up and down) and the inventory has room, and the client hears three things in one tick, in
 * this order: `collect` (`playerCollect`), the stack's `set_slot`, `remove_entities` (`entityGone`). A pickup that only
 * fits in part (Mine Labs 2026-10-23, 1.21.4) sends the slot alone: no `collect`, no `remove_entities`, no new count for
 * the entity, which stays on the client with the count it was spawned with. A full inventory picks nothing up.
 */
import assert from "node:assert/strict";
import type { Entity } from "prismarine-entity";
import { Vec3 } from "vec3";
import type { ContractCheck } from "../checks.ts";
import { answerArrives, answerSettled, serverQuiet } from "../server-answer.ts";
import type { ContractSubject } from "../subject.ts";
import { type TimedMark, latenessRecorded, latenessSaid, markTimed, readingWindow } from "./late-reading-window.ts";
import { markNow, tickOf } from "./server-tick-marks.ts";

/** Thirty-five different items of one each, so they fill 35 of the 36 slots and the cobblestone stack has the last. */
const FILLER = [
  "dirt", "sand", "gravel", "stick", "coal", "iron_ingot", "gold_ingot", "diamond", "emerald", "redstone", "glass", "clay_ball",
  "brick", "paper", "book", "string", "feather", "flint", "bone", "leather", "apple", "bread", "carrot", "potato", "wheat",
  "sugar", "egg", "snowball", "arrow", "torch", "ladder", "oak_planks", "oak_log", "stone", "granite",
];
/** Cobblestone the last slot can still take: the three pickups below take 1, 3 and (of 8) the 1 left. */
const ROOM = 5;
const PICKUP_DELAY_TICKS = 20;
/**
 * Measured over 6 runs (Mine Labs 2026-10-23): 961-1011 ms from the client seeing the spawn to the collect for 20 ticks (1000 ms), the three events
 * within 0.3 ms. Judged by the server's ticks, as `tossed-item-kept-before-delay` does: one reading sent right before the summon (the spawn's tick
 * or just before it) and one sent when the client heard the collect (the pickup's tick or later by the collect reading's own round trip and a
 * stall's catch-up: `late-reading-window.ts`).
 */
/** Collect, slot and removal come in one tick: the client hears them within this wall gap (a client side bound). */
const SAME_TICK_GAP_MS = 100;
/** The bot's half width, the pickup reach sideways (the box grown by 1 block) and an item's half width: a bit past 1.425 is out of reach. */
const INSIDE_REACH = 1.3;
const OUTSIDE_REACH = 1.55;
const FEET = [0.5, -60, 0.5] as const;

/** `mark` is the server's tick read when the client heard a collect. */
type Heard = { readonly kind: "playerCollect" | "updateSlot" | "entityGone"; readonly entityId?: number; readonly collectorId?: number; readonly atMs: number; readonly mark?: TimedMark };

/** What the client heard, as a failure text carries it: the kind, the entity, who collected it and when (the `mark` is a pending reading). */
const heardText = (heard: readonly Heard[]): string => JSON.stringify(heard.map(({ kind, entityId, collectorId, atMs }) => ({ kind, entityId, collectorId, atMs })));

/** What the client hears of cobblestone and of item entities, in order. */
function listen(subject: ContractSubject): { readonly heard: Heard[]; stop(): void } {
  const { bot } = subject;
  const cobblestone = bot.registry.itemsByName.cobblestone!.id;
  const heard: Heard[] = [];
  const onCollect = (collector: Entity, collected: Entity) => void heard.push({ kind: "playerCollect", entityId: collected.id, collectorId: collector.id, atMs: subject.now(), mark: markTimed(subject) });
  const onSlot = (_slot: number, _old: unknown, next: { type: number } | null) => {
    if (next?.type === cobblestone) heard.push({ kind: "updateSlot", atMs: subject.now() });
  };
  const onGone = (entity: Entity) => void heard.push({ kind: "entityGone", entityId: entity.id, atMs: subject.now() });
  bot.on("playerCollect", onCollect);
  bot.inventory.on("updateSlot", onSlot);
  bot.on("entityGone", onGone);
  return {
    heard,
    stop() {
      bot.off("playerCollect", onCollect);
      bot.inventory.off("updateSlot", onSlot);
      bot.off("entityGone", onGone);
    },
  };
}

/** Summon cobblestone `count` at `position`, as the client has it. */
const summonCobblestone = (subject: ContractSubject, count: number, position: Vec3, delayTicks: number): Promise<Entity> =>
  subject.summonItem({ name: "cobblestone", count }, position, delayTicks);

export const itemPickupAfterDelay: ContractCheck = {
  name: "item-pickup-after-delay",
  // Bare bot: our runtime must not walk to items lying near it while the check measures the server (review of T3b-C).
  withoutRuntime: true,
  exclusive:
    "kept on a server of its own until a lane batch shows it green: the 20-tick delay used to be asserted in wall milliseconds, which another lane's clone (it freezes the server thread 0.16-0.9 s) put out (red on lanes, 2026-10-24); it is judged by the server's ticks read in chat (`time query gametime`) since 2026-10-30 (plan 2026-10-30-contract-batch-timing T2a), which a stall does not move",
  fixture: { cells: {}, carried: { cobblestone: 64 - ROOM, ...Object.fromEntries(FILLER.map((name) => [name, 1])) }, position: [0.5, -60, 0.5] },
  async run(subject) {
    const { bot } = subject;
    const feet = subject.world(FEET);
    const cobblestone = bot.registry.itemsByName.cobblestone!.id;
    const carried = () => bot.inventory.count(cobblestone, null);
    const { heard, stop } = listen(subject);
    try {
      // On the other side of the bot from the item below: two stacks of the same item within about half a block merge into one (vanilla `ItemEntity.mergeWithNeighbours`,
      // the merge box is the item's grown by 0.5 sideways), and a merge before the pickup left the bot with 2, entity 38 gone with no collect (3 reds in 20 alone, 2026-11-01).
      const outside = await summonCobblestone(subject, 1, feet.offset(-OUTSIDE_REACH, 0, 0), 0);
      await serverQuiet(subject, `an item ${OUTSIDE_REACH} blocks away`);
      assert.equal(bot.entities[outside.id], outside, `an item ${OUTSIDE_REACH} blocks away was picked up`);
      assert.equal(heard.length, 0, `heard ${heardText(heard)} for an item out of reach`);

      const inside = await summonCobblestone(subject, 1, feet.offset(INSIDE_REACH, 0, 0), 0);
      await answerArrives(
        subject,
        () => carried() === 64 - ROOM + 1 && bot.entities[inside.id] === undefined,
        `the item ${INSIDE_REACH} blocks away (delay 0) was not picked up`,
        () => `the item ${bot.entities[inside.id] ? `still at ${bot.entities[inside.id]!.position}` : "is gone"}, the bot at ${bot.entity.position} on ground ${bot.entity.onGround}, carrying ${carried()} of ${64 - ROOM + 1}, the bot is entity ${bot.entity.id}, heard ${heardText(heard)}`,
      );
      heard.length = 0;

      // Read before the summon, as the toss's is: the server runs the two in order, so the reading is the spawn's tick or just before it, never after a client that heard the spawn late.
      const spawned = markNow(subject);
      const whole = await summonCobblestone(subject, 3, feet.offset(0, 0, 1), PICKUP_DELAY_TICKS);
      await answerSettled(subject, () => heard.length >= 3, "the pickup of a stack that fits");
      assert.deepEqual(heard.map(({ kind }) => kind), ["playerCollect", "updateSlot", "entityGone"], "what the client heard of a pickup that fits");
      assert.ok(heard.every(({ entityId }) => entityId === undefined || entityId === whole.id));
      const spawnTick = await tickOf(subject, spawned);
      const collectTick = await tickOf(subject, heard[0]!.mark!);
      const afterTicks = collectTick - spawnTick;
      const roundTripMs = await heard[0]!.mark!.roundTripMs;
      const window = readingWindow(PICKUP_DELAY_TICKS, roundTripMs);
      assert.ok(
        afterTicks >= window.min && afterTicks <= window.max,
        `the pickup came ${afterTicks} server ticks after the spawn (tick ${spawnTick} to ${collectTick}), delay ${PICKUP_DELAY_TICKS} ticks: not within ${window.min} to ${window.max} (${latenessSaid("collect", roundTripMs, window.lateTicks)})`,
      );
      assert.ok(heard[2]!.atMs - heard[0]!.atMs <= SAME_TICK_GAP_MS, "collect, slot and removal came in one tick");
      assert.equal(carried(), 64 - ROOM + 1 + 3);
      heard.length = 0;

      const partial = await summonCobblestone(subject, 8, feet.offset(0, 0, 1), PICKUP_DELAY_TICKS);
      await answerSettled(subject, () => heard.length >= 1, "the pickup of a stack that fits in part");
      assert.deepEqual(heard.map(({ kind }) => kind), ["updateSlot"], "what the client heard of a pickup that fits in part");
      assert.equal(carried(), 64, "the stack filled up");
      assert.equal(bot.entities[partial.id], partial, "the partly picked-up entity is gone on the client");
      assert.equal(partial.getDroppedItem()?.count, 8, "the client was told a new count for the partly picked-up entity");
      heard.length = 0;

      const full = await summonCobblestone(subject, 2, feet.offset(0, 0, 0), 0);
      await serverQuiet(subject, "an item picked up by nobody: the inventory is full");
      assert.deepEqual(heard, [], "something was picked up with a full inventory");
      assert.equal(bot.entities[full.id], full);
      return latenessRecorded(PICKUP_DELAY_TICKS, afterTicks, roundTripMs);
    } finally {
      stop();
    }
  },
};
