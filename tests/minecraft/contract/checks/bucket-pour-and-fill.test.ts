/**
 * The wait of `bucket-pour-and-fill` before the wall pour: the source the fill took leaves flowing water around it that
 * recedes over seconds (measured on Mine Labs 1.21.4, 2026-10-24: the wall cell, 4 cells away, held `water level 6` when
 * the wall pour began), and the first update the wall pour hears must be its own. The fake has no fluid flow, so these
 * tests give it the flow and its recession by hand.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot, createFakeClock } from "../../../../src/test-support/fake-bot/index.ts";
import { ZERO_ARENA, arenaFrame } from "../../arena/frame.ts";
import { awaitFlowDried, bucketPourAndFill, isTakenSourceUpdate } from "./bucket-pour-and-fill.ts";
import { fakeContractSubject } from "../subject.ts";

const TAKEN_CELL = new Vec3(2, -60, 0);
const WALL_CELL = new Vec3(-2, -60, 0);
const NEAR_CELL = new Vec3(3, -60, 0);
/** 7 steps by path from the taken source: the last cell the flow reaches. */
const FAR_CELL = new Vec3(9, -60, 0);
/** 8 steps by path along the row; and 9 along a diagonal, inside the 15 x 15 square around the source. */
const OUT_OF_REACH_CELL = new Vec3(10, -60, 0);
const DIAGONAL_OUT_OF_REACH_CELL = new Vec3(6, -60, 5);
const flowing = (level: number) => ({ name: "water", properties: { level } });

function bucketScene() {
  const { cells, carried, position } = bucketPourAndFill.fixture;
  const harness = createFakeBot({
    clock: createFakeClock({ mode: "mocked" }),
    position: new Vec3(...position),
    ...(cells !== undefined && { cells }),
    ...(carried !== undefined && { carried }),
  });
  return { harness, subject: fakeContractSubject(harness, arenaFrame(ZERO_ARENA)) };
}

/** Run `change` on the mocked clock `afterMs` from now. */
function inMs(afterMs: number, change: () => void): void {
  setTimeout(change, afterMs);
}

// `multi_block_change` carried only `water level 2` for the cell in all 4 fill reds of 30 trials (Mine Labs 1.21.4, 2026-10-24, 4 lanes).
const TAKEN_UPDATES: readonly [string | undefined, boolean][] = [
  ["air", true],
  ["water level 2", true],
  ["water level 7", true],
  ["water level 0", false],
  ["stone", false],
  ["null", false],
  [undefined, false],
];

test("a taken source's first update is air or the flow's refill; the source again, a solid block, a removal or nothing is no take", () => {
  for (const [update, taken] of TAKEN_UPDATES) assert.equal(isTakenSourceUpdate(update), taken, String(update));
});

test("the wait does not hold for nothing, nor for water out of the flow's reach (more than 7 steps by path)", async () => {
  for (const wetCell of [undefined, OUT_OF_REACH_CELL, DIAGONAL_OUT_OF_REACH_CELL]) {
    const { harness, subject } = bucketScene();
    using _installed = harness.clock.install();
    if (wetCell !== undefined) harness.world.setCell(wetCell, flowing(1));
    const startedAt = subject.now();
    await awaitFlowDried(subject, TAKEN_CELL);
    assert.ok(subject.now() - startedAt < 3_000, `waited ${subject.now() - startedAt} ms with water at ${String(wetCell)}: nothing to wait for but the 40 ticks`);
  }
});

test("the wait holds while flowing water is within 7 steps of the taken source and ends once it is gone", async () => {
  const { harness, subject } = bucketScene();
  using _installed = harness.clock.install();
  for (const cell of [WALL_CELL, NEAR_CELL, FAR_CELL]) harness.world.setCell(cell, flowing(3));
  inMs(2_500, () => [WALL_CELL, NEAR_CELL, FAR_CELL].forEach((cell) => harness.world.setCell(cell, "air")));
  const startedAt = subject.now();
  await awaitFlowDried(subject, TAKEN_CELL);
  assert.ok(subject.now() - startedAt >= 2_500, "returned while the flow was still there");
});

test("a flow that has not dried in 5 s fails naming the source and the cells still wet", async () => {
  const { harness, subject } = bucketScene();
  using _installed = harness.clock.install();
  harness.world.setCell(WALL_CELL, flowing(5));
  await assert.rejects(
    awaitFlowDried(subject, TAKEN_CELL),
    (error: Error) => /the flow from the source taken at \(2, -60, 0\) had not dried within 5 s/.test(error.message) && error.message.includes("-4,0=water level 5"),
  );
});

test("water that comes back within the 40 ticks after the cells were dry fails: dry once is not dried", async () => {
  const { harness, subject } = bucketScene();
  using _installed = harness.clock.install();
  harness.world.setCell(WALL_CELL, flowing(5));
  inMs(500, () => harness.world.setCell(WALL_CELL, "air"));
  inMs(1_200, () => harness.world.setCell(WALL_CELL, flowing(6)));
  await assert.rejects(awaitFlowDried(subject, TAKEN_CELL), /flowed again within 40 ticks/);
});

test("a server that sends no ticks fails on the wall bound, not on ticks alone", async () => {
  const { harness, subject } = bucketScene();
  using _installed = harness.clock.install();
  await subject.wait(1_500);
  harness.server.stop();
  const startedAt = subject.now();
  await assert.rejects(awaitFlowDried(subject, TAKEN_CELL), /the world age moved less than 40 ticks/);
  assert.ok(subject.now() - startedAt <= 5_100, `waited ${subject.now() - startedAt} ms`);
});

test("the whole check passes when the taken source's flow recedes through the wall cell: a step of it lands right after the wall pour starts listening", async () => {
  const { harness, subject } = bucketScene();
  using _installed = harness.clock.install();
  /** One step of the recession: a flowing cell takes the next level, the last level leaves air; a source is left as it is. */
  const recede = () => {
    const block = harness.bot.blockAt(WALL_CELL);
    if (block?.name !== "water") return;
    const level = Number(block.getProperties().level);
    if (level > 0) harness.world.setCell(WALL_CELL, level < 7 ? flowing(level + 1) : "air");
  };
  let taken = false;
  harness.bot.on(`blockUpdate:${TAKEN_CELL}` as "blockUpdate:(x, y, z)", (_before, after) => {
    if (taken || after?.name !== "air") return;
    taken = true;
    // The flow around the taken source reaches the wall cell and dries a level every 700 ms (scripted, slower than the game's 5 ticks a step so the race has room; not measured).
    harness.world.setCell(WALL_CELL, flowing(4));
    for (let step = 1; step <= 4; step++) inMs(step * 700, recede);
  });
  // The race the red lost: the server's next flow step falls between the client listening to the cell and the pour.
  const onNewListener = (event: string) => {
    if (event === `blockUpdate:${WALL_CELL}`) inMs(10, recede);
  };
  harness.bot.on("newListener" as never, onNewListener as never);
  await bucketPourAndFill.run(subject);
  assert.ok(taken, "the fill never took the source");
});
