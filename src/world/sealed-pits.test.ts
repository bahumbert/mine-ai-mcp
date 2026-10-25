import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { type FakeBotOptions, createFakeBot } from "../test-support/fake-bot/index.js";
import { createDiscardedItems, DISCARD_MEMORY_MS } from "./discarded-items.js";
import {
  forgetEmptySealedPits,
  rememberSealedPit,
  SEALED_PIT_LIMIT,
  SEALED_PIT_SETTLE_MS,
  sealedPitGuarding,
  sealedPitItemIds,
} from "./sealed-pits.js";

const BOTTOM = { x: 10, y: 62, z: 10 };

const droppedItem = (id: number, x: number, y: number, z: number) => ({
  id,
  name: "item",
  position: new Vec3(x, y, z),
  getDroppedItem: () => ({ name: "dirt", count: 1 }),
});

/** A bot standing at the origin; `entities` are the item entities it sees, `options` what else the world has. */
const watching = (entities: ReturnType<typeof droppedItem>[] = [], options: Omit<FakeBotOptions, "entities"> = {}) =>
  createFakeBot({
    groundY: null,
    ...options,
    entities: Object.fromEntries(entities.map(({ id, ...entity }) => [id, entity])),
  }).bot;

test("the guard volume is the 3x3 column from two below the bottom to the lower plug, plus the top plug", () => {
  const bot = watching();
  rememberSealedPit(bot, BOTTOM);
  const guards = (x: number, y: number, z: number) => sealedPitGuarding(bot, x, y, z);
  for (const [x, y, z] of [[10, 62, 10], [9, 60, 9], [11, 63, 11], [10, 61, 10], [10, 64, 10]] as const)
    assert.deepEqual(guards(x, y, z), BOTTOM, `${x} ${y} ${z}`);
  for (const [x, y, z] of [[12, 62, 10], [10, 59, 10], [11, 64, 10], [10, 65, 10], [8, 63, 10], [10, 62, 12]] as const)
    assert.equal(guards(x, y, z), null, `${x} ${y} ${z}`);
});

test("items lying in a remembered pit are listed by id, items beside it are not", () => {
  const bot = watching([
    droppedItem(1, 10.5, 62.2, 10.5),
    droppedItem(2, 10.5, 63.1, 10.5),
    droppedItem(3, 12.5, 62.2, 10.5),
    droppedItem(4, 10.5, 64.5, 10.5),
  ]);
  rememberSealedPit(bot, BOTTOM);
  assert.deepEqual([...sealedPitItemIds(bot)].sort(), [1, 2]);
});

test("a buried stack stays ignored through the discard registry past its wall-clock memory", () => {
  const bot = watching([droppedItem(1, 10.5, 62.2, 10.5), droppedItem(5, 30.5, 62.2, 10.5)]);
  rememberSealedPit(bot, BOTTOM);
  const discarded = createDiscardedItems(DISCARD_MEMORY_MS, () => sealedPitItemIds(bot));
  discarded.remember([5], 0);
  assert.deepEqual([...discarded.ignored(DISCARD_MEMORY_MS + 1)], [1]);
});

test("a pit seen loaded and empty within 16 blocks is forgotten, one out of sight is kept", () => {
  const later = SEALED_PIT_SETTLE_MS + 1;
  const near = watching(); // bottom 10 blocks away, its cell loaded
  rememberSealedPit(near, BOTTOM, 0);
  forgetEmptySealedPits(near, 1);
  assert.notEqual(sealedPitGuarding(near, 10, 62, 10), null, "a server may still be spawning the stack: settle time first");
  forgetEmptySealedPits(near, later);
  assert.equal(sealedPitGuarding(near, 10, 62, 10), null);

  const unloaded = watching([], { cells: { "10,62,10": "void" } });
  rememberSealedPit(unloaded, BOTTOM, 0);
  forgetEmptySealedPits(unloaded, later);
  assert.notEqual(sealedPitGuarding(unloaded, 10, 62, 10), null, "its cell is not loaded: nothing was seen");

  const far = watching([], { position: new Vec3(40.5, 64, 10.5) });
  rememberSealedPit(far, BOTTOM, 0);
  forgetEmptySealedPits(far, later);
  assert.notEqual(sealedPitGuarding(far, 10, 62, 10), null, "30 blocks away: out of the watch distance");

  const holding = watching([droppedItem(1, 10.5, 62.2, 10.5)]);
  rememberSealedPit(holding, BOTTOM, 0);
  forgetEmptySealedPits(holding, later);
  assert.notEqual(sealedPitGuarding(holding, 10, 62, 10), null, "an item still lies in it");
});

test("the 33rd pit forgets the oldest", () => {
  const bot = watching();
  for (let index = 0; index <= SEALED_PIT_LIMIT; index++) rememberSealedPit(bot, { x: 100 + index * 5, y: 62, z: 0 }, index);
  assert.equal(sealedPitGuarding(bot, 100, 62, 0), null);
  assert.notEqual(sealedPitGuarding(bot, 105, 62, 0), null);
  assert.notEqual(sealedPitGuarding(bot, 100 + SEALED_PIT_LIMIT * 5, 62, 0), null);
  rememberSealedPit(bot, { x: 105, y: 62, z: 0 }, 99);
  assert.notEqual(sealedPitGuarding(bot, 105, 62, 0), null, "a pit already remembered is not listed twice nor pushes another out");
  assert.notEqual(sealedPitGuarding(bot, 110, 62, 0), null);
});

test("another dimension's pit guards nothing and lists no item", () => {
  const bot = watching([droppedItem(1, 10.5, 62.2, 10.5)]);
  rememberSealedPit(bot, BOTTOM);
  bot.game.dimension = "the_nether";
  assert.equal(sealedPitGuarding(bot, 10, 62, 10), null);
  assert.deepEqual([...sealedPitItemIds(bot)], []);
  bot.game.dimension = "overworld";
  assert.notEqual(sealedPitGuarding(bot, 10, 62, 10), null);
});
