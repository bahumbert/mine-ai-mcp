import assert from "node:assert/strict";
import test from "node:test";
import { createFakeBot } from "../../test-support/fake-bot/index.js";
import { observeNavigationDigs, reportNavigationDig, type NavigationDig } from "./dig-observer.js";

const stoneByHand: NavigationDig = { block: "stone", toolType: null, ms: 1500 };

test("every open listener of the bot gets each reported dig", () => {
  const { bot } = createFakeBot();
  const first: NavigationDig[] = [];
  const second: NavigationDig[] = [];
  const closeFirst = observeNavigationDigs(bot, (dig) => first.push(dig));
  const closeSecond = observeNavigationDigs(bot, (dig) => second.push(dig));
  reportNavigationDig(bot, stoneByHand);
  reportNavigationDig(bot, { block: "dirt", toolType: 5, ms: 200 });
  assert.deepEqual(first.map((dig) => dig.block), ["stone", "dirt"]);
  assert.deepEqual(second.map((dig) => dig.block), ["stone", "dirt"]);
  // A closed listener gets no further dig (closing twice is harmless); the open one keeps getting them.
  closeFirst();
  closeFirst();
  reportNavigationDig(bot, stoneByHand);
  assert.equal(first.length, 2);
  assert.equal(second.length, 3);
  closeSecond();
});

test("a throwing listener never stops the others nor the report", () => {
  const { bot } = createFakeBot();
  const seen: NavigationDig[] = [];
  const closeThrowing = observeNavigationDigs(bot, () => {
    throw new Error("listener bug");
  });
  const closeSeen = observeNavigationDigs(bot, (dig) => seen.push(dig));
  assert.doesNotThrow(() => reportNavigationDig(bot, stoneByHand));
  assert.equal(seen.length, 1);
  closeThrowing();
  closeSeen();
});

test("listeners belong to one bot: another bot's digs do not reach them", () => {
  const { bot } = createFakeBot();
  const { bot: other } = createFakeBot();
  const seen: NavigationDig[] = [];
  const close = observeNavigationDigs(bot, (dig) => seen.push(dig));
  reportNavigationDig(other, stoneByHand);
  assert.equal(seen.length, 0);
  close();
});

test("a dig reported with no listener is dropped without error", () => {
  const { bot } = createFakeBot();
  assert.doesNotThrow(() => reportNavigationDig(bot, stoneByHand));
});
