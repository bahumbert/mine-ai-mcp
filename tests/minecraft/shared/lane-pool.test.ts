import test from "node:test";
import assert from "node:assert/strict";
import { LanePool } from "./lane-pool.ts";

test("lanes are handed out lowest free index first, starting at 1 (lane 0 is for refused scenarios)", () => {
  const pool = new LanePool(8);
  assert.deepEqual([pool.acquire()?.index, pool.acquire()?.index, pool.acquire()?.index], [1, 2, 3]);
});

test("a released lane is the next one handed out", () => {
  const pool = new LanePool(8);
  const [one, two] = [pool.acquire()!, pool.acquire()!];
  pool.release(one);
  assert.equal(pool.acquire()?.index, 1);
  assert.equal(two.index, 2);
});

test("a full pool hands out nothing", () => {
  const pool = new LanePool(2);
  pool.acquire();
  pool.acquire();
  assert.equal(pool.acquire(), null);
});

test("releasing a lane that is not held throws instead of freeing another trial's lane", () => {
  const pool = new LanePool(4);
  const lane = pool.acquire()!;
  pool.release(lane);
  assert.throws(() => pool.release(lane), /lane 1 is not held/u);
});

test("a quarantined lane is never handed out again and counts as quarantined", () => {
  const pool = new LanePool(4);
  const lane = pool.acquire()!;
  pool.quarantine(lane);
  assert.equal(pool.quarantinedCount, 1);
  assert.equal(pool.acquire()?.index, 2);
});

test("half the lanes in use quarantined asks for a restart", () => {
  const pool = new LanePool(8);
  const lanes = [pool.acquire()!, pool.acquire()!, pool.acquire()!, pool.acquire()!];
  assert.equal(pool.needsRestart, false);
  pool.quarantine(lanes[0]!);
  assert.equal(pool.needsRestart, false);
  pool.quarantine(lanes[1]!);
  assert.equal(pool.needsRestart, true);
});

test("1000 random admissions, settlements, aborts and quarantines never give one lane to two trials", () => {
  let seed = 12345;
  const random = (limit: number): number => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed % limit;
  };
  const pool = new LanePool(20);
  const held = new Map<number, ReturnType<LanePool["acquire"]>>();
  for (let step = 0; step < 1000; step++) {
    const action = random(4);
    if (action <= 1 || held.size === 0) {
      const lane = pool.acquire();
      if (!lane) continue;
      assert.equal(held.has(lane.index), false, `lane ${lane.index} handed out twice at step ${step}`);
      held.set(lane.index, lane);
      continue;
    }
    const index = [...held.keys()][random(held.size)]!;
    const lane = held.get(index)!;
    held.delete(index);
    if (action === 2) pool.release(lane!);
    else if (random(10) === 0) pool.quarantine(lane!);
    else pool.release(lane!);
    assert.equal(pool.heldCount, held.size);
  }
});

test("the pool counts the lanes still free: not held, not quarantined", () => {
  const pool = new LanePool(5);
  const [one, two] = [pool.acquire()!, pool.acquire()!];
  pool.quarantine(one);
  assert.equal(pool.freeCount, 3);
  pool.release(two);
  assert.equal(pool.freeCount, 4);
});
