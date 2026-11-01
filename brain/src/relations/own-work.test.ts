import assert from "node:assert/strict";
import test from "node:test";
import { OwnWork } from "./own-work.ts";

const names = (own: OwnWork): string[] => [...own.yields()].sort();

/** A step of `item` that ended; `look` hands it to a tick. */
function endedStep(item: string): OwnWork {
  const own = new OwnWork();
  own.startStep(new Set([item]));
  assert.deepEqual(names(own), [item], "a running step's yields count");
  own.endStep();
  return own;
}

test("what a step yielded goes to the tick that sees its end and to one more counted tick, then is dropped", () => {
  const own = endedStep("oak_log");
  own.advance(0);
  own.handedOver(); // look 1 starts tick 1
  own.advance(1); // tick 1 counted: the window shifts
  assert.deepEqual(names(own), ["oak_log"], "tick 2 still counts a late sapling as the step's own");
  assert.equal(own.active(), true);
  own.handedOver();
  own.advance(2);
  assert.deepEqual(names(own), []);
  assert.equal(own.active(), false);
});

test("a tick that counted nothing (no baseline) does not use up the window", () => {
  const own = endedStep("oak_log");
  own.handedOver();
  own.advance(0); // its status() failed: the counter did not move
  own.handedOver();
  own.advance(1);
  assert.deepEqual(names(own), ["oak_log"], "the first counted tick shifts it to the last window");
  own.advance(2);
  assert.deepEqual(names(own), []);
});

test("a step that ends while a tick runs is not used up by that tick: it gets its own two ticks", () => {
  const own = endedStep("oak_log");
  own.handedOver(); // tick N reads the bag before the next step ends
  own.startStep(new Set(["cobblestone"]));
  own.endStep();
  own.advance(1); // tick N counted
  assert.deepEqual(names(own), ["cobblestone", "oak_log"]);
  own.handedOver(); // tick N+1 is the first to see the cobblestone step's end
  own.advance(2);
  assert.deepEqual(names(own), ["cobblestone"], "oak_log is gone, cobblestone waits for its one more tick");
  own.handedOver();
  own.advance(3);
  assert.deepEqual(names(own), []);
});

test("two steps between ticks keep both yields", () => {
  const own = endedStep("oak_log");
  own.startStep(new Set(["cobblestone"]));
  own.endStep();
  own.handedOver();
  own.advance(1);
  assert.deepEqual(names(own), ["cobblestone", "oak_log"]);
});

test("a hand-off that ends is own work for the tick that sees it and the next counted one", () => {
  const own = new OwnWork();
  own.startOwnWork();
  assert.equal(own.active(), true);
  own.endOwnWork();
  own.handedOver();
  own.advance(1);
  assert.equal(own.active(), true);
  own.handedOver();
  own.advance(2);
  assert.equal(own.active(), false);
});

test("idle clears what ended, but not a running step", () => {
  const own = endedStep("oak_log");
  own.handedOver();
  own.advance(1);
  own.idle();
  assert.deepEqual(names(own), []);
  assert.equal(own.active(), false);
  own.startStep(new Set(["stone"]));
  own.idle();
  assert.deepEqual(names(own), ["stone"]);
  assert.equal(own.active(), true);
});
