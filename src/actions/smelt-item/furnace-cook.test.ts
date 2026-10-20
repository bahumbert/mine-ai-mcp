// The wait for a cook: when it counts as done, and the ingots a mid-cook take moved beyond what the window showed.
import assert from "node:assert/strict";
import test from "node:test";
import { waitForCook, type FurnaceWindow, type Harvest } from "./furnace-cook.js";

/** A furnace window double whose slots the test sets; `pause` advances a fake clock and runs the script for that moment. */
function cooking(script: (now: number, state: { input: number; output: number; cook: number }) => void) {
  const state = { input: 0, output: 0, cook: 0 };
  let now = 0;
  const window = {
    inputItem: () => (state.input > 0 ? { count: state.input } : null),
    fuelItem: () => null,
    outputItem: () => (state.output > 0 ? { count: state.output } : null),
    get progress() { return state.cook; },
    get fuel() { return 0.5; },
  } as unknown as FurnaceWindow;
  const clock = {
    now: () => now,
    pause: async (milliseconds: number) => {
      now += milliseconds;
      script(now, state);
    },
  };
  return { window, clock, state };
}

/** A harvest that has already taken `taken` ingots out of the window, as a mid-cook take of the stack does. */
function harvestAfterTake(taken: number): Harvest & { readonly credited: () => number } {
  let total = taken;
  let credited = 0;
  return {
    taken: () => total,
    item: () => (taken > 0 ? { name: "iron_ingot", inventoryBefore: 0 } : null),
    takeReady: async () => {},
    credit: (count: number) => {
      total += count;
      credited += count;
    },
    credited: () => credited,
  };
}

test("every loaded item consumed and the output slot empty: ingots a take moved beyond what the window showed are credited", async () => {
  // The window showed 2 ingots when the harvest clicked; the server's stack held 3 and moved them all (live, busy-smelt-interrupted).
  const { window, clock, state } = cooking((now, furnace) => {
    furnace.input = now < 300 ? 1 : 0;
    furnace.cook = now < 300 ? 0.5 : 0;
    furnace.output = 0;
  });
  state.input = 1;
  const harvest = harvestAfterTake(2);
  const waited = await waitForCook(window, 3, clock, undefined, undefined, harvest);
  assert.equal(waited.verdict, "completed");
  assert.equal(harvest.taken(), 3);
  assert.equal(harvest.credited(), 1);
});

test("an input that was never seen in the furnace is not read as consumed", async () => {
  const { window, clock } = cooking(() => {});
  const harvest = harvestAfterTake(2);
  const waited = await waitForCook(window, 3, clock, undefined, undefined, harvest);
  assert.equal(waited.verdict, "stalled");
  assert.equal(harvest.credited(), 0);
});

test("with nothing taken yet there is no take to blame: an empty furnace is not credited", async () => {
  const { window, clock, state } = cooking((now, furnace) => {
    furnace.input = now < 300 ? 1 : 0;
  });
  state.input = 1;
  const harvest = harvestAfterTake(0);
  const waited = await waitForCook(window, 3, clock, undefined, undefined, harvest);
  assert.equal(waited.verdict, "stalled");
  assert.equal(harvest.credited(), 0);
});

test("ingots still in the output slot are counted as before, and nothing is credited", async () => {
  const { window, clock, state } = cooking((now, furnace) => {
    furnace.input = now < 300 ? 1 : 0;
    furnace.output = now < 300 ? 0 : 1;
  });
  state.input = 1;
  const harvest = harvestAfterTake(2);
  const waited = await waitForCook(window, 3, clock, undefined, undefined, harvest);
  assert.equal(waited.verdict, "completed");
  assert.equal(harvest.credited(), 0);
});

test("an input slot seen empty for one observation only, before the output slot caught up, is not credited", async () => {
  // The input and output slots update in separate packets: one observation between them must not read as drained.
  const { window, clock, state } = cooking((now, furnace) => {
    furnace.input = now < 200 ? 1 : 0;
    furnace.cook = 0;
    furnace.output = now < 200 ? 0 : now < 300 ? 0 : 1;
  });
  state.input = 1;
  const harvest = harvestAfterTake(2);
  const waited = await waitForCook(window, 3, clock, undefined, undefined, harvest);
  assert.equal(waited.verdict, "completed");
  assert.equal(harvest.credited(), 0);
});

test("every loaded item consumed with an ingot still in the output slot: the takes' miss is credited, the slot is counted", async () => {
  // smelt-batch-normal, 16 items: the takes counted 14, the slot holds 1, the furnace consumed all 16 inputs.
  const { window, clock, state } = cooking((now, furnace) => {
    furnace.input = now < 300 ? 1 : 0;
    furnace.output = now < 300 ? 0 : 1;
  });
  state.input = 1;
  const harvest = harvestAfterTake(1);
  const waited = await waitForCook(window, 3, clock, undefined, undefined, harvest);
  assert.equal(waited.verdict, "completed");
  assert.equal(harvest.credited(), 1, "3 requested, 1 taken, 1 in the slot: one went uncounted");
});
