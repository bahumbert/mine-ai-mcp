import assert from "node:assert/strict";
import test from "node:test";
import { flush } from "../../src/test-support/fake-bot/fake-clock.ts";
import type { UnfinishedHouse } from "./skills.ts";
import { UnfinishedHouseSaver } from "./unfinished-house-saver.ts";

const house = (part: number): UnfinishedHouse => ({ kind: "small medieval house", site: { door: { x: 0, y: 64, z: 0 }, facing: "north" }, part, prepared: true, materials: {} });

/** A saver over a house the test changes, whose saves answer the booleans given in turn (the last one stays). */
function saverOver(answers: boolean[]) {
  const state = { house: null as UnfinishedHouse | null, saved: [] as (UnfinishedHouse | null)[] };
  const saver = new UnfinishedHouseSaver(async (current) => {
    state.saved.push(current);
    return answers.length > 1 ? answers.shift()! : answers[0]!;
  }, () => state.house);
  return { state, saver };
}

test("a failed note_save is tried again", async () => {
  const { state, saver } = saverOver([false, true]);
  state.house = house(1);
  saver.request();
  await flush();
  saver.request();
  await flush();
  saver.request();
  await flush();
  assert.deepEqual(state.saved, [house(1), house(1)], "asked again after the failure, not again after it went through");
});

test("a house is saved at once, and a quick run of changes saves the latest one", async () => {
  const { state, saver } = saverOver([true]);
  state.house = house(1);
  saver.request();
  assert.equal(state.saved.length, 1, "the save is asked before request() returns, so its call is queued ahead of the caller's next one");
  state.house = house(2);
  saver.request();
  state.house = null;
  saver.request();
  await flush();
  assert.deepEqual(state.saved.at(-1), null, "no unfinished house is the last thing saved");
  assert.ok(state.saved.length <= 3);
});

test("a house the memory already holds is not saved again", async () => {
  const { state, saver } = saverOver([true]);
  state.house = house(1);
  saver.known(house(1));
  saver.request();
  await flush();
  assert.deepEqual(state.saved, []);
});
