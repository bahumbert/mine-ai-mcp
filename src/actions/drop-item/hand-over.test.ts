import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { createDiscardedItems } from "../../world/discarded-items.js";
import { awaitHandover, cameFromToss, rememberDiscards } from "./hand-over.js";

const ITEM_ID = 77;
const STACK = 3;

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
