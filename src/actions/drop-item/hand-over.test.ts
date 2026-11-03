import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { setCarriedCount } from "../../test-support/carried-counts.js";
import type { FakeBot, FakeClock } from "../../test-support/fake-bot/index.js";
import { createDiscardedItems } from "../../world/discarded-items.js";
import { type DroppedItem, parseDropItemRequest } from "./contract.js";
import { dropItem } from "./drop-item.js";
import { deps, dropBot, dropTest, type Stack } from "./drop-item-fixtures.test.js";
import { awaitHandover, cameFromToss, recountAfterToss, rememberDiscards } from "./hand-over.js";

const ITEM_ID = 77;
const STACK = 3;
const GIVER_ID = 1;

/** A bot that sees one tossed item entity of `STACK` items and a recipient, plus the raw `collect` channel. */
function handoverBot() {
  const client = new EventEmitter();
  const entities: Record<number, unknown> = {
    [ITEM_ID]: { id: ITEM_ID, name: "item", position: new Vec3(0, 64, 1), getDroppedItem: () => ({ name: "bread", count: STACK }) },
    9: { id: 9, username: "Theo" },
  };
  const bot = Object.assign(new EventEmitter(), { _client: client, entities, time: { age: 0 } }) as unknown as Bot;
  return { bot, client };
}

/** What the recipient took when the server's `collect` packet carries `pickupItemCount` (absent when `undefined`). */
async function takenWhenAnnounced(pickupItemCount: unknown, expectedItems: number) {
  const { bot, client } = handoverBot();
  const waiting = awaitHandover(bot, { recipientName: "Theo", isTossed: () => false, tossedIds: new Set([ITEM_ID]), expectedItems, wallMs: 30 });
  client.emit("collect", { collectedEntityId: ITEM_ID, collectorEntityId: 9, ...(pickupItemCount === undefined ? {} : { pickupItemCount }) });
  return (await waiting).recipientCount;
}

test("a collect packet's pickup count is taken as announced when it is a positive whole number", async () => {
  assert.equal(await takenWhenAnnounced(2, 10), 2);
});

test("a collect packet with no pickup count, 0 or a fraction counts the stack of the item", async () => {
  assert.equal(await takenWhenAnnounced(undefined, 10), STACK, "an older server says nothing");
  assert.equal(await takenWhenAnnounced(0, 10), STACK);
  assert.equal(await takenWhenAnnounced(1.5, 10), STACK);
});

test("a toss claims the item entities that appeared near the bot, even one whose metadata has not arrived", () => {
  const { bot } = handoverBot();
  (bot as unknown as { entity: unknown }).entity = { position: new Vec3(0, 64, 0) };
  const entities = bot.entities as Record<number, any>;
  entities[78] = { id: 78, name: "item", position: new Vec3(0, 64, 1), getDroppedItem: () => { throw new Error("no metadata yet"); } };
  entities[79] = { id: 79, name: "zombie", position: new Vec3(0, 64, 1), getDroppedItem: () => null };
  entities[80] = { id: 80, name: "item", position: new Vec3(0, 64, 9), getDroppedItem: () => ({ name: "bread", count: 1 }) };
  const claimed = rememberDiscards(bot, new Set([9]), createDiscardedItems());
  assert.deepEqual([...claimed].sort(), [ITEM_ID, 78]);
});

test("cameFromToss: a new item entity near the toss spot, with or without its metadata; not an old or far one", () => {
  const { bot } = handoverBot();
  const at = { x: 0, y: 64, z: 0 };
  const entities = bot.entities as Record<number, any>;
  const unnamed = { id: 81, name: "item", position: new Vec3(1, 64, 1), getDroppedItem: () => { throw new Error("no metadata yet"); } };
  assert.equal(cameFromToss(entities[ITEM_ID], new Set(), at), true);
  assert.equal(cameFromToss(unnamed as never, new Set(), at), true);
  assert.equal(cameFromToss(entities[ITEM_ID], new Set([ITEM_ID]), at), false, "it was there before the toss");
  assert.equal(cameFromToss(entities[ITEM_ID], new Set(), { x: 0, y: 64, z: 20 }), false, "far from the toss spot");
  assert.equal(cameFromToss({ id: 82, name: "zombie", position: new Vec3(0, 64, 1), getDroppedItem: () => null } as never, new Set(), at), false);
});

// awaitHandover: whose pickup counts as the recipient's take (plan 2026-11-02 Task R, review gaps 1 and 2).
test("the giver's own collect of a tossed-looking item is not a take: the watch stays open and the recipient has none", async () => {
  const { bot, client } = handoverBot();
  (bot as unknown as { entity: unknown }).entity = { id: GIVER_ID, position: new Vec3(0, 64, 0) };
  (bot.entities as Record<number, unknown>)[GIVER_ID] = { id: GIVER_ID, username: "Giver" };
  const waiting = awaitHandover(bot, { recipientName: "Theo", isTossed: () => true, tossedIds: new Set(), expectedItems: STACK, wallMs: 30 });
  client.emit("collect", { collectedEntityId: ITEM_ID, collectorEntityId: GIVER_ID, pickupItemCount: STACK });
  const outcome = await waiting;
  assert.equal(outcome.settled, false, "the giver's pickup did not end the wait as 'all taken'");
  assert.equal(outcome.recipientCount, 0);
  assert.equal(outcome.recipientTookOf.size, 0);
});

test("the recipient's take is counted per item name; an entity of another name that looks like the toss is not a take", async () => {
  const { bot, client } = handoverBot();
  const entities = bot.entities as Record<number, any>;
  entities[90] = { id: 90, name: "item", position: new Vec3(0, 64, 1), getDroppedItem: () => ({ name: "dirt", count: 2 }) };
  const waiting = awaitHandover(bot, {
    recipientName: "Theo",
    isTossed: (entity) => entity.id === 90 || entity.id === ITEM_ID,
    tossedIds: new Set(),
    expectedItems: STACK,
    tossedCounts: new Map([["bread", STACK]]),
    wallMs: 30,
  });
  client.emit("collect", { collectedEntityId: 90, collectorEntityId: 9, pickupItemCount: 2 });
  client.emit("collect", { collectedEntityId: ITEM_ID, collectorEntityId: 9, pickupItemCount: STACK });
  const outcome = await waiting;
  assert.deepEqual([...outcome.recipientTookOf], [["bread", STACK]]);
  assert.equal(outcome.recipientTookAll, true);
});

test("a tossed entity claimed by id whose name is another item's is no take; one whose stack Mineflayer emptied keeps the name it had", async () => {
  const { bot, client } = handoverBot();
  const entities = bot.entities as Record<number, any>;
  entities[90] = { id: 90, name: "item", position: new Vec3(0, 64, 1), getDroppedItem: () => ({ name: "dirt", count: 2 }) };
  const waiting = awaitHandover(bot, {
    recipientName: "Theo",
    isTossed: () => false,
    tossedIds: new Set([ITEM_ID, 90]),
    expectedItems: STACK + 1,
    tossedCounts: new Map([["bread", STACK], ["cobblestone", 1]]),
    wallMs: 30,
  });
  client.emit("collect", { collectedEntityId: 90, collectorEntityId: 9, pickupItemCount: 2 }); // the recipient's own dirt, claimed beside the toss
  entities[ITEM_ID].getDroppedItem = () => null; // the stack is gone when the packet is heard
  client.emit("collect", { collectedEntityId: ITEM_ID, collectorEntityId: 9, pickupItemCount: STACK });
  const outcome = await waiting;
  assert.deepEqual([...outcome.recipientTookOf], [["bread", STACK]]);
  assert.equal(outcome.recipientTookAll, false, "the cobblestone was not taken");
});

test("an entity with no name yet is the recipient's take only when a single item was tossed", async () => {
  for (const [tossedCounts, taken] of [[new Map([["bread", STACK]]), STACK], [new Map([["bread", 2], ["dirt", 1]]), 0]] as const) {
    const { bot, client } = handoverBot();
    (bot.entities as Record<number, any>)[ITEM_ID].getDroppedItem = () => { throw new Error("no metadata yet"); };
    const waiting = awaitHandover(bot, { recipientName: "Theo", isTossed: () => true, tossedIds: new Set(), expectedItems: STACK, tossedCounts, wallMs: 30 });
    client.emit("collect", { collectedEntityId: ITEM_ID, collectorEntityId: 9, pickupItemCount: STACK });
    assert.equal((await waiting).recipientCount, taken);
  }
});

// recountAfterToss: the server's confirmed take is a floor under the bag recount (live s3l: 2 tossed, 2 taken, 3 came back).
for (const [dropped, taken, cameBack, net] of [[2, 2, 3, 2], [4, 2, 5, 2], [2, 1, 1, 1], [2, 0, 2, 0], [2, 0, 1, 1]] as const) {
  dropTest(`recount: tossed ${dropped}, recipient took ${taken}, ${cameBack} came back -> net ${net}`, async ({ clock }) => {
    const { bot, harness } = dropBot({ carried: [] }, clock);
    setCarriedCount(harness.inventory, bot.registry, bot.registry.itemsByName.beef!.id, cameBack);
    const entries: DroppedItem[] = [{ item: "beef", requested: null, carriedBefore: dropped, carriedAfter: 0, dropped }];
    recountAfterToss(bot, entries, null, new Map(taken > 0 ? [["beef", taken]] : []));
    assert.equal(entries[0]!.dropped, net);
    assert.equal(entries[0]!.error === undefined, net > 0);
  });
}

// The whole action: a hand-over to Theo, whose pickup the test announces as the server does.
const THEO_ID = 42;

function handOverBot(clock: FakeClock, carried: readonly Stack[]) {
  return dropBot({ carried, players: { Theo: { id: THEO_ID, position: { x: 1, y: 64, z: 1 } } }, position: { x: 0, y: 64, z: 0 }, tossWaitsForSpawn: true }, clock);
}

type Harness = ReturnType<typeof dropBot>["harness"];

/** The recipient takes every tossed stack lying near (of `names` when given): the raw packet, `playerCollect`, then the entity is gone. */
function recipientTakesTheToss(harness: Harness, names?: readonly string[]): void {
  const { bot } = harness;
  for (const entity of Object.values(bot.entities).filter((candidate) => candidate.name === "item")) {
    const stack = entity.getDroppedItem();
    if (!stack || (names && !names.includes(stack.name))) continue;
    // stopgap: waits for a contract check of another player's pickup, then the fake
    bot.emit("playerCollect", bot.entities[THEO_ID]!, entity);
    entity.getDroppedItem = () => null; // Mineflayer's handler (the first listener) has emptied the stack when later listeners hear the packet
    bot._client.emit("collect", { collectedEntityId: entity.id, collectorEntityId: THEO_ID, pickupItemCount: stack.count });
    harness.entities.remove(entity.id);
  }
}

const hasTossed = (bot: FakeBot) => Object.values(bot.entities).some((entity) => entity.name === "item" && entity.getDroppedItem());

/** A walk-off that does what the test says to the toss, once, with the giver ending `blocks` away; later sides do nothing. */
function walkOff(harness: Harness, clock: FakeClock, during: () => void, blocks = 3) {
  let done = false;
  return (async () => {
    if (done || !hasTossed(harness.bot)) return { status: "completed", elapsedMs: 1 };
    done = true;
    harness.bot.entity.position.x -= blocks;
    during();
    await clock.sleep(300);
    return { status: "completed", elapsedMs: 1 };
  }) as never;
}

const handOverRequest = (items: { item_name: string; count?: number }[]) => parseDropItemRequest({ items, to_player: "Theo" });

dropTest("recipient took all, then the giver picked up the same item on its walk -> succeeded, dropped 2, no [DROP_PICKED_UP] (live s3l 2026-11-01)", async ({ clock, run }) => {
  const { harness, bot } = handOverBot(clock, [{ name: "beef", count: 2 }]);
  const navigate = walkOff(harness, clock, () => {
    recipientTakesTheToss(harness);
    // The giver's own pickup (its collect packet is sent by the fake) of 3 beef lying within 4 blocks of the toss.
    harness.entities.spawn({ name: "item", position: bot.entity.position.clone(), item: { name: "beef", count: 3 }, pickupDelayTicks: 0 });
  });
  const result = await run(dropItem(bot, handOverRequest([{ item_name: "beef" }]), {}, deps({ navigate }), createDiscardedItems()));
  assert.equal(result.status, "succeeded", JSON.stringify(result));
  assert.equal(result.drop.recipient?.collected, true);
  assert.equal(result.drop.recipient?.collectedCount, 2);
  assert.equal(result.drop.dropped[0]?.dropped, 2);
  assert.equal(result.drop.dropped[0]?.error, undefined);
  assert.equal(bot.inventory.count(bot.registry.itemsByName.beef!.id, null), 3, "the giver carries the 3 it picked up");
});

dropTest("the giver's own collect of a new same-name item near the toss is not the recipient's take", async ({ clock, run }) => {
  const { harness, bot } = handOverBot(clock, [{ name: "beef", count: 2 }]);
  const navigate = walkOff(harness, clock, () => {
    harness.entities.spawn({ name: "item", position: bot.entity.position.clone(), item: { name: "beef", count: 3 }, pickupDelayTicks: 0 });
  });
  const result = await run(dropItem(bot, handOverRequest([{ item_name: "beef" }]), {}, deps({ navigate, handoverWallMs: 2_000 }), createDiscardedItems()));
  assert.equal(result.drop.recipient?.collected, false);
  assert.equal(result.drop.recipient?.collectedCount, 0);
  assert.match(result.drop.dropped[0]?.error ?? "", /\[DROP_PICKED_UP\]/, "the recount decides: 3 came back for 2 tossed");
});

dropTest("the recipient picks up its own block drop near the toss -> not a take of the toss (a different item name)", async ({ clock, run }) => {
  const { harness, bot } = handOverBot(clock, [{ name: "beef", count: 2 }]);
  const navigate = walkOff(harness, clock, () => {
    const stray = harness.entities.spawn({ name: "item", position: bot.entity.position.clone(), item: { name: "dirt", count: 2 }, pickupDelayTicks: 40 });
    // stopgap: waits for a contract check of another player's pickup, then the fake
    bot._client.emit("collect", { collectedEntityId: stray.id, collectorEntityId: THEO_ID, pickupItemCount: 2 });
    harness.entities.remove(stray.id);
  });
  const result = await run(dropItem(bot, handOverRequest([{ item_name: "beef" }]), {}, deps({ navigate, handoverWallMs: 2_000 }), createDiscardedItems()));
  assert.equal(result.drop.recipient?.collected, false);
  assert.equal(result.drop.recipient?.collectedCount, 0);
});

dropTest("two items, the recipient took all of one -> collected false, the other recounted", async ({ clock, run }) => {
  const { harness, bot } = handOverBot(clock, [{ name: "beef", count: 2 }, { name: "bread", count: 2 }]);
  const navigate = walkOff(harness, clock, () => recipientTakesTheToss(harness, ["beef"]));
  const result = await run(dropItem(bot, handOverRequest([{ item_name: "beef" }, { item_name: "bread" }]), {}, deps({ navigate, handoverWallMs: 2_000 }), createDiscardedItems()));
  assert.equal(result.drop.recipient?.collected, false);
  assert.equal(result.drop.recipient?.collectedCount, 2);
  assert.deepEqual(result.drop.dropped.map((entry) => [entry.item, entry.dropped, entry.error]), [["beef", 2, undefined], ["bread", 2, undefined]]);
});
