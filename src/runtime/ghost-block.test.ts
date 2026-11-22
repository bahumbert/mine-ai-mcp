import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { type FakeBotOptions, createFakeBot } from "../test-support/fake-bot/fake-bot.js";
import { type FakeClock, createFakeClock } from "../test-support/fake-bot/fake-clock.js";
import { listenersAddedSince } from "../test-support/fake-bot/listener-counts.js";
import { cellsAround, watchGhostBlocks } from "./ghost-block.js";

/** The count window of `ghost-block.ts` (`WINDOW_MS`), written out here so a change of the constant turns the boundary cases red. */
const WINDOW_MS = 2_000;
/** `RESYNC_WINDOW_MS` and `PAUSE_MS` of `ghost-block.ts`, written out for the same reason. */
const RESYNC_WINDOW_MS = 30_000;
const PAUSE_MS = 60_000;
const SPOT =new Vec3(191.5, 79, 292.5);

/**
 * A bot standing at `at` on the shared fake, the watcher on its default clock (monotonic, so the installed mocked clock drives it).
 * A correction is the server's own position packet (`server.sendPosition`: the fake's client handler sets the position and emits
 * `forcedMove`, `fake-bot-physics.ts` "position"). A resync is the `block_place` packet the client wrote (`server.packets`). What the
 * fake does with that packet (`fake-bot-placement.ts` `answerPlacement`, hand 1 on the bot's own cells): the held item is the off-hand
 * slot; a shield or a totem is no block, so it only acknowledges the click's sequence and sends no block change. A vanilla server also
 * answers with the clicked cell's real block (`ghost-block.ts` `askServerForCell`; no contract check measures it yet), so these tests
 * prove what the watcher sends and when, never that the cells were put right.
 */
function standingBot(clock: FakeClock, offHandItem: string | null = null, at = SPOT, entities: FakeBotOptions["entities"] = {}) {
  const harness = createFakeBot({ clock, position: at, entities, slots: { 45: offHandItem === null ? null : { name: offHandItem } } });
  const logs: string[] = [];
  // The first `stepWallClock` wraps the mock `Date.now`; a caller that took `Date.now` before it keeps the unwrapped one and never sees a later step, as no real `Date.now` would behave. A zero step wraps it now.
  clock.stepWallClock(0);
  const added = listenersAddedSince(harness.bot);
  const stop = watchGhostBlocks(harness.bot, { log: (line) => logs.push(line) });
  const resyncs = () => harness.server.packets.filter((packet) => packet.name === "block_place").map((packet) => packet.data as Record<string, unknown>);
  /** The server puts her back at (x, y, z), `afterMs` after the previous correction. */
  const correct = async (afterMs: number, x = at.x, y = at.y, z = at.z) => {
    if (afterMs > 0) await clock.advance(afterMs);
    harness.server.sendPosition(new Vec3(x, y, z));
  };
  const correctTimes = async (count: number, everyMs: number) => { for (let i = 0; i < count; i++) await correct(everyMs); };
  /** `count` corrections, the first at once and each of the others `everyMs` after the one before. */
  const correctFromNow = async (count: number, everyMs: number) => { await correct(0); await correctTimes(count - 1, everyMs); };
  return { harness, bot: harness.bot, added, resyncs, logs, stop, correct, correctTimes, correctFromNow };
}

/** A test with its own mocked clock installed (the default watcher clock reads `performance.now`). */
function ghostTest(name: string, body: (clock: FakeClock) => Promise<void> | void): void {
  test(name, async () => {
    const clock = createFakeClock({ mode: "mocked" });
    using _timers = clock.install();
    await body(clock);
  });
}

ghostTest("eight corrections at one spot in a second send an off-hand use-item-on to 3 to 12 cells", async (clock) => {
  const { resyncs, correctTimes } = standingBot(clock);
  await correctTimes(8, 100);
  const packets = resyncs();
  assert.ok(packets.length >= 3 && packets.length <= 12, `${packets.length} packets`);
  for (const params of packets) {
    assert.equal(params.hand, 1);
    assert.equal(params.direction, 1);
    assert.equal(params.insideBlock, false);
    assert.equal(params.worldBorderHit, false);
    assert.equal(typeof params.sequence, "number");
    assert.deepEqual([params.cursorX, params.cursorY, params.cursorZ], [0.5, 1, 0.5]);
  }
});

ghostTest("seven corrections do nothing", async (clock) => {
  const { resyncs, correctTimes } = standingBot(clock);
  await correctTimes(7, 100);
  assert.equal(resyncs().length, 0);
});

ghostTest("eight corrections spread over three seconds do nothing (a /tp or a respawn is one, a slow fight is not a loop)", async (clock) => {
  const { resyncs, correctTimes } = standingBot(clock);
  await correctTimes(8, 400);
  assert.equal(resyncs().length, 0);
});

// The eighth correction lands `lastAfterFirstMs` after the first (the seven before it 100 ms apart); the wall clock steps by `wallStepMs`
// after the seventh. Only the monotonic gap counts: WINDOW_MS resyncs, WINDOW_MS + 1 does not, a wall step of 2 s neither hides nor invents a loop.
for (const { name, lastAfterFirstMs, wallStepMs, resyncs: resyncsExpected } of [
  { name: "the last exactly WINDOW_MS after the first", lastAfterFirstMs: WINDOW_MS, wallStepMs: 0, resyncs: true },
  { name: "the last WINDOW_MS + 1 after the first", lastAfterFirstMs: WINDOW_MS + 1, wallStepMs: 0, resyncs: false },
  { name: "the last WINDOW_MS + 1 after the first, the wall clock stepped back 2 s (a slow loop must not look fast)", lastAfterFirstMs: WINDOW_MS + 1, wallStepMs: -WINDOW_MS, resyncs: false },
  { name: "the last WINDOW_MS after the first, the wall clock stepped forward 2 s (a fast loop must not be hidden)", lastAfterFirstMs: WINDOW_MS, wallStepMs: WINDOW_MS, resyncs: true },
]) {
  ghostTest(`eight corrections at one spot, ${name}: ${resyncsExpected ? "resync" : "nothing sent"}`, async (clock) => {
    const { resyncs, correct, correctTimes } = standingBot(clock);
    await correct(0);
    await correctTimes(6, 100);
    clock.stepWallClock(wallStepMs);
    await correct(lastAfterFirstMs - 600);
    if (resyncsExpected) assert.ok(resyncs().length >= 3);
    else assert.equal(resyncs().length, 0);
  });
}

ghostTest("corrections alternating between two spots never trigger", async (clock) => {
  const { resyncs, correct } = standingBot(clock);
  for (let i = 0; i < 20; i++) await correct(50, i % 2 === 0 ? 191.5 : 193.5);
  assert.equal(resyncs().length, 0);
});

ghostTest("corrections while she rides a vehicle do nothing", async (clock) => {
  const { bot, resyncs, correctTimes } = standingBot(clock, null, SPOT, { 7: { name: "oak_boat", position: SPOT.offset(0, 0, 3) } });
  bot.mount(bot.entities[7]!);
  await clock.advance(50);
  assert.notEqual(bot.vehicle, null, "the server seated her");
  await correctTimes(12, 50);
  assert.equal(resyncs().length, 0);
});

ghostTest("an off hand holding dirt sends nothing and logs one line naming the item, however many corrections follow", async (clock) => {
  const { resyncs, logs, correctTimes } = standingBot(clock, "dirt");
  await correctTimes(24, 100);
  assert.equal(resyncs().length, 0);
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /ghost block at 191\.5 79 292\.5: off hand holds dirt, not resynced/u);
});

ghostTest("an off hand holding a shield or a totem is resynced", async (clock) => {
  for (const item of ["shield", "totem_of_undying"]) {
    const { resyncs, correctTimes } = standingBot(clock, item);
    await correctTimes(8, 100);
    assert.ok(resyncs().length >= 3, item);
  }
});

ghostTest("a fourth trigger at the same spot inside 30 s sends nothing and logs 'not resolved' once; after 60 s it resyncs again", async (clock) => {
  const { resyncs, logs, correctTimes } = standingBot(clock);
  await correctTimes(8, 100); // trigger 1 (the spot is first seen at the 1st correction)
  const perResync = resyncs().length;
  await correctTimes(8, 100); // 2
  await correctTimes(8, 100); // 3
  assert.equal(resyncs().length, 3 * perResync);
  await correctTimes(8, 100); // 4: given up
  assert.equal(resyncs().length, 3 * perResync);
  assert.equal(logs.filter((line) => line.includes("ghost block not resolved at 191.5 79 292.5")).length, 1);
  await correctTimes(16, 100); // still paused: no packet, no second line
  assert.equal(resyncs().length, 3 * perResync);
  assert.equal(logs.filter((line) => line.includes("not resolved")).length, 1);
  await clock.advance(60_000);
  await correctTimes(8, 100);
  assert.equal(resyncs().length, 4 * perResync);
});

ghostTest("the resync count forgets a resync once it is RESYNC_WINDOW_MS old: a fourth trigger gives up at exactly that age and resyncs one ms later", async (clock) => {
  for (const [afterFirstResyncMs, resyncsAgain] of [[RESYNC_WINDOW_MS, false], [RESYNC_WINDOW_MS + 1, true]] as const) {
    const { resyncs, correctTimes, correctFromNow } = standingBot(clock);
    await correctTimes(8, 100); // trigger 1: the first resync, at the 8th correction
    const firstResyncAt = clock.now();
    const perResync = resyncs().length;
    await correctTimes(8, 100); // 2
    await correctTimes(8, 100); // 3
    await clock.advance(afterFirstResyncMs - 1_600 - 700); // trigger 4's 8th correction lands afterFirstResyncMs after the first resync
    await correctFromNow(8, 100);
    assert.equal(clock.now() - firstResyncAt, afterFirstResyncMs);
    assert.equal(resyncs().length, (resyncsAgain ? 4 : 3) * perResync, `${afterFirstResyncMs} ms after the first resync`);
  }
});

ghostTest("a given-up spot stays paused until PAUSE_MS after the give-up: a trigger one ms before sends nothing, one at that age resyncs", async (clock) => {
  for (const [afterGiveUpMs, resyncsAgain] of [[PAUSE_MS - 1, false], [PAUSE_MS, true]] as const) {
    const { resyncs, correctTimes, correctFromNow } = standingBot(clock);
    await correctTimes(8, 100); // trigger 1
    const perResync = resyncs().length;
    await correctTimes(8, 100); // 2
    await correctTimes(8, 100); // 3
    await correctTimes(8, 100); // trigger 4: given up, paused
    const giveUpAt = clock.now();
    await clock.advance(afterGiveUpMs - 700); // the next trigger's 8th correction lands afterGiveUpMs after the give-up
    await correctFromNow(8, 100);
    assert.equal(clock.now() - giveUpAt, afterGiveUpMs);
    assert.equal(resyncs().length, (resyncsAgain ? 4 : 3) * perResync, `${afterGiveUpMs} ms after the give-up`);
  }
});

ghostTest("a death in the middle of the count starts it again", async (clock) => {
  const { bot, resyncs, correctTimes } = standingBot(clock);
  await correctTimes(5, 100);
  bot.emit("death");
  await correctTimes(5, 100);
  assert.equal(resyncs().length, 0);
});

ghostTest("a spawn forgets a given-up spot", async (clock) => {
  const { bot, resyncs, correctTimes } = standingBot(clock);
  for (let i = 0; i < 4; i++) await correctTimes(8, 100);
  const sent = resyncs().length;
  bot.emit("spawn");
  await correctTimes(8, 100);
  assert.ok(resyncs().length > sent);
});

ghostTest("after the cleanup a correction sends nothing and no listener is left", async (clock) => {
  const { added, resyncs, stop, correctTimes } = standingBot(clock);
  for (const event of ["forcedMove", "death", "spawn"]) assert.equal(added(event), 1, `${event} while watching`);
  stop();
  await correctTimes(12, 100);
  assert.equal(resyncs().length, 0);
  for (const event of ["forcedMove", "death", "spawn"]) assert.equal(added(event), 0, event);
});

ghostTest("two bots each count their own corrections", async (clock) => {
  const first = standingBot(clock);
  const second = standingBot(clock);
  await first.correctTimes(4, 100);
  await second.correctTimes(4, 100);
  await first.correctTimes(4, 100);
  assert.ok(first.resyncs().length > 0);
  assert.equal(second.resyncs().length, 0);
});

test("cellsAround in the middle of one column gives the three levels of that column", () => {
  const cells = cellsAround(new Vec3(10.5, 64, 5.5));
  assert.deepEqual(cells.map((cell) => cell.toArray().join(",")).sort(), ["10,63,5", "10,64,5", "10,65,5"]);
});

test("cellsAround on a corner of four columns gives 12 cells", () => {
  const cells = cellsAround(new Vec3(10.2, 64, 5.8));
  assert.equal(cells.length, 12);
  assert.deepEqual([...new Set(cells.map((cell) => `${cell.x},${cell.z}`))].sort(), ["10,5", "10,6", "9,5", "9,6"]);
});

test("cellsAround with feet just under a block level (63.92) takes the levels of floor(y), not of the block above", () => {
  const cells = cellsAround(new Vec3(10.5, 63.92, 5.5));
  assert.deepEqual(cells.map((cell) => cell.y).sort(), [62, 63, 64]);
});

ghostTest("a resync is logged with the spot and the number of cells asked", async (clock) => {
  const { resyncs, logs, correctTimes } = standingBot(clock);
  await correctTimes(8, 100);
  assert.deepEqual(logs, [`ghost block at 191.5 79 292.5: resynced ${resyncs().length} cells`]);
});
