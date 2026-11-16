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
    takeReady: async () => false,
    credit: (count: number) => {
      total += count;
      credited += count;
    },
    credited: () => credited,
  };
}

test("consumed input credits a take's missed ingot, with or without output still in the slot", async () => {
  for (const { taken, output, cook } of [{ taken: 2, output: 0, cook: 0.5 }, { taken: 1, output: 1, cook: 0 }]) {
    // Live busy-smelt-interrupted and smelt-batch-normal: an output take can move one more than the window showed.
    const { window, clock, state } = cooking((now, furnace) => {
      furnace.input = now < 300 ? 1 : 0;
      furnace.cook = now < 300 ? cook : 0;
      furnace.output = now < 300 ? 0 : output;
    });
    state.input = 1;
    const harvest = harvestAfterTake(taken);
    const waited = await waitForCook(window, 3, clock, undefined, undefined, harvest);
    assert.equal(waited.verdict, "completed");
    assert.equal(harvest.taken(), 3 - output);
    assert.equal(harvest.credited(), 1);
  }
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


test("the safety deadline follows the recipe's cooking ticks: a slower cook is given proportionally longer", async () => {
  const endOf = async (cookTicks: number) => {
    // Always cooking, never done: only the deadline ends the wait.
    const { window, clock, state } = cooking((now, furnace) => {
      furnace.input = 1;
      furnace.cook = ((now / 100) % 50) / 50 + 0.01;
    });
    state.input = 1;
    const waited = await waitForCook(window, 3, clock, undefined, undefined, undefined, cookTicks);
    return { verdict: waited.verdict, endedAt: clock.now() };
  };
  const standard = await endOf(200);
  const slow = await endOf(400);
  assert.equal(standard.verdict, "safety_timeout");
  assert.equal(slow.verdict, "safety_timeout");
  assert.ok(slow.endedAt > standard.endedAt * 1.5, `standard ${standard.endedAt} ms, slow ${slow.endedAt} ms`);
});

test("a harvest take that waited 20 s for its answer at 2 tps does not end the cook as stalled", async () => {
  const { window, clock, state } = cooking((now, furnace) => {
    if (now >= 20_200) { furnace.input = 0; furnace.output = 1; }
  });
  state.input = 1;
  state.output = 8;
  let taken = 0;
  const harvest: Harvest = {
    ...harvestAfterTake(0),
    taken: () => taken,
    takeReady: async (output) => {
      if (output < 8) return false;
      state.output = 0;
      taken += 8;
      await clock.pause(20_000);
      return true;
    },
  };
  assert.equal((await waitForCook(window, 9, clock, undefined, undefined, harvest)).verdict, "completed");
});
