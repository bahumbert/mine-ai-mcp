import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot, createFakeClock } from "../test-support/fake-bot/index.js";
import { observeFormations, pourAim, settleFormations, settledFormations, watchFormations } from "./liquid.js";

/**
 * The vanilla rule these tests encode, measured in the `pour-through-lava`
 * fixture: a full bucket's ray ignores fluid, stops at the first solid face,
 * and the liquid lands in the cell in front of that face. So a bot on the lip
 * of a pool level with its floor pours by looking at the floor *through* the
 * lava, and the water lands in the lava cell itself.
 */
const cell = (x: number, y: number, z: number) => new Vec3(x, y, z);
const lands = (landing: Vec3) => (candidate: Vec3) => (candidate.equals(landing) ? 1 : null);

/** A shore at y 60 with a pool of lava level with it, its near source at x 4. */
function shore(): Record<string, string> {
  const named: Record<string, string> = {};
  for (let x = 0; x <= 8; x += 1) {
    for (let z = -2; z <= 2; z += 1) {
      named[`${x},59,${z}`] = "stone";
      named[`${x},60,${z}`] = x >= 4 && x <= 6 && Math.abs(z) <= 1 ? "lava" : "stone";
    }
  }
  return named;
}

test("a pour aimed through a pool lands in the lava cell itself", () => {
  const { bot } = createFakeBot({ cells: shore(), groundY: null, position: cell(3.5, 61, 0.5) });

  const aim = pourAim(bot, lands(cell(4, 60, 0)));

  assert.notEqual(aim, null);
  // The ray lands on the top of the pool floor; the water goes into the cell
  // in front of that face, which is the source it passed through.
  assert.deepEqual(aim?.surface, cell(4, 59, 0));
  assert.deepEqual(aim?.lookAt, cell(4.5, 60, 0.5));
});

test("a pour whose ray would cross liquid first is refused", () => {
  const { bot } = createFakeBot({ cells: shore(), groundY: null, position: cell(3.5, 61, 0.5) });

  // A source in the middle of the pool: every cell around it is lava, so the
  // only face that lands there is its own floor, and the ray to that floor
  // crosses the near sources. Those would turn to obsidian behind the water,
  // walling the scoop off from the cell it just filled.
  assert.equal(pourAim(bot, lands(cell(5, 60, 0))), null);
  // The same landing is offered when it is not the ray's own fault.
  assert.notEqual(pourAim(bot, lands(cell(4, 60, 0))), null);
});

test("a pool under a lid offers no pour, because every ray meets the lid", () => {
  const named = shore();
  for (let x = 3; x <= 7; x += 1) named[`${x},61,0`] = "stone";
  const { bot } = createFakeBot({ cells: named, groundY: null, position: cell(2.5, 62, 0.5) });

  assert.equal(pourAim(bot, lands(cell(4, 60, 0))), null);
});

test("a cell out of the ray's reach is refused however good it scores", () => {
  const { bot } = createFakeBot({ cells: shore(), groundY: null, position: cell(0.5, 61, 0.5) });

  assert.equal(pourAim(bot, lands(cell(6, 60, 0))), null);
});

test("the highest-scoring landing wins, and the shortest ray breaks a tie", () => {
  const { bot } = createFakeBot({ cells: shore(), groundY: null, position: cell(3.5, 61, 0.5) });
  const underfoot = cell(3, 61, 0);
  const source = cell(4, 60, 0);
  const score = (high: Vec3) => (landing: Vec3) =>
    landing.equals(high) ? 3 : landing.equals(underfoot) || landing.equals(source) ? 1 : null;

  // The cell the bot stands in is the shortest ray in the world; a better
  // score still beats it, and with the scores level it wins.
  assert.deepEqual(pourAim(bot, score(source))?.landing, source);
  assert.deepEqual(pourAim(bot, score(underfoot))?.landing, underfoot);
});

/** A world whose cells the test changes between observations: air where nothing is named. */
function changingWorld(initial: Record<string, string>) {
  return createFakeBot({ cells: initial, groundY: null });
}

test("lava flowing onto water forms stone and it is counted by name", () => {
  const { bot, world } = changingWorld({ "0,0,0": "water", "1,0,0": "lava" });
  const watch = watchFormations(bot, cell(0, 0, 0));

  world.setCell(cell(0, 0, 0), "stone");

  assert.deepEqual(observeFormations(bot, watch), { stone: 1 });
});

test("water on lava counts each block it made under its own name", () => {
  const { bot, world } = changingWorld({ "0,0,0": "lava", "1,0,0": "lava", "2,0,0": "lava" });
  const watch = watchFormations(bot, cell(0, 0, 0));

  world.setCell(cell(0, 0, 0), "obsidian");
  world.setCell(cell(1, 0, 0), "obsidian");
  world.setCell(cell(2, 0, 0), "cobblestone");

  assert.deepEqual(observeFormations(bot, watch), { obsidian: 2, cobblestone: 1 });
});

test("a block placed where air was is not formed by a liquid", () => {
  const { bot, world } = changingWorld({ "0,0,0": "water" });
  const watch = watchFormations(bot, cell(0, 0, 0));

  world.setCell(cell(1, 0, 0), "dirt");

  assert.deepEqual(observeFormations(bot, watch), {});
});

test("air a liquid flowed into and that then hardened is counted", () => {
  const { bot, world } = changingWorld({ "0,0,0": "lava" });
  const watch = watchFormations(bot, cell(0, 0, 0));

  world.setCell(cell(1, 0, 0), "lava");
  assert.deepEqual(observeFormations(bot, watch), {});
  world.setCell(cell(1, 0, 0), "cobblestone");

  assert.deepEqual(observeFormations(bot, watch), { cobblestone: 1 });
});

test("a block that stood there before the pour is not counted", () => {
  const { bot } = changingWorld({ "0,0,0": "lava", "1,0,0": "obsidian" });
  const watch = watchFormations(bot, cell(0, 0, 0));

  assert.deepEqual(observeFormations(bot, watch), {});
});

test("a cell beyond the formation radius is not watched", () => {
  const { bot, world } = changingWorld({ "0,0,0": "lava", "11,0,0": "water" });
  const watch = watchFormations(bot, cell(0, 0, 0));

  world.setCell(cell(11, 0, 0), "stone");

  assert.deepEqual(observeFormations(bot, watch), {});
});

test("a cancel ends the wait for a pour to settle at once when physics has stopped, not at Mineflayer's 5 s tick timeout", async () => {
  const { bot, clock } = changingWorld({ "0,0,0": "lava" });
  const watch = watchFormations(bot, cell(0, 0, 0));
  const abort = new AbortController();
  bot.physicsEnabled = false; // a death turns physics off (`physics.js:480`)
  clock.after(100, () => abort.abort(new Error("bot died")));

  await assert.rejects(clock.settle(settledFormations(bot, watch, abort.signal), 1_000), /bot died/);
  assert.equal(bot.listenerCount("physicsTick"), 0, "the aborted wait left no tick listener");
});

// Packet cadence: contract world-age-at-slow-tick; formation timing: T11b trace-5 (2026-11-15).
for (const [index, scenario] of [
  { rate: 5, changes: [3, 5], stop: null, ms: 8_000, age: 24_040, ended: "quiet" },
  { rate: 5, changes: [30], stop: null, ms: 12_000, age: 24_060, ended: "quiet" },
  { rate: 20, changes: [3, 5], stop: null, ms: 2_000, age: 24_040, ended: "quiet" },
  { rate: 10, changes: [39, 60], stop: null, ms: 10_000, age: 24_100, ended: "timeout" },
  { rate: 5, changes: [3, 5], stop: 2_000, ms: 21_000, age: 24_000, ended: "stalled" },
  { rate: 5, changes: [3, 5], stop: 5_000, ms: 24_000, age: 24_020, ended: "stalled" },
].entries()) {
  test(`formations at ticks ${scenario.changes} at ${scenario.rate} tps, stop ${scenario.stop}: ${scenario.ended}`, async () => {
    const clock = createFakeClock({ mode: "mocked" });
    using _timers = index === 0 ? clock.install() : null;
    const { bot, world, server } = createFakeBot({
      cells: { "0,0,0": "lava", "1,0,0": "lava" }, groundY: null,
      server: { ticksPerSecond: scenario.rate }, clock,
    });
    const watch = watchFormations(bot, cell(0, 0, 0));
    let ticks = 0;
    server.onTick(() => {
      ticks += 1;
      scenario.changes.forEach((at, index) => {
        if (ticks === at) world.setCell(cell(index, 0, 0), "obsidian");
      });
    });
    if (scenario.stop !== null) clock.after(scenario.stop, () => server.stop());
    const countOnly = index === 0
      ? settledFormations(bot, watchFormations(bot, cell(0, 0, 0)), undefined)
        .then((formed) => ({ formed, ms: clock.now(), age: bot.time.age }))
      : null;
    const result = await clock.settle(settleFormations(bot, watch, undefined, clock), 25_000);
    assert.deepEqual(result, { formed: { obsidian: scenario.changes.length }, ended: scenario.ended });
    assert.ok(clock.now() >= scenario.ms && clock.now() <= scenario.ms + 100, `ended at ${clock.now()} ms`);
    assert.equal(bot.time.age, scenario.age);
    if (countOnly) assert.deepEqual(await countOnly, { formed: result.formed, ms: 8_000, age: 24_040 });
  });
}

for (const rate of [5, 10]) test(`formations changing every server tick time out at age +100 at ${rate} tps`, async () => {
  const cells: Record<string, string> = {};
  for (let x = -5; x < 5; x += 1) for (let z = -5; z < 5; z += 1) cells[`${x},0,${z}`] = "lava";
  const { bot, world, clock, server } = createFakeBot({ cells, groundY: null, server: { ticksPerSecond: rate } });
  const watch = watchFormations(bot, cell(0, 0, 0));
  const wet = watch.cells.filter((position) => bot.blockAt(position)?.name === "lava");
  let tick = 0;
  server.onTick(() => {
    const position = wet[tick++];
    if (position) world.setCell(position, "obsidian");
  });
  const result = await clock.settle(settleFormations(bot, watch, undefined, clock), 100_000 / rate + 1_000);
  assert.deepEqual(result, { formed: { obsidian: 100 }, ended: "timeout" });
  assert.equal(clock.now(), 100_000 / rate);
  assert.equal(bot.time.age, 24_100);
});

test("aborting formation settling rejects with the reason and cancels its timer", async () => {
  const { bot, clock } = createFakeBot();
  const controller = new AbortController();
  const reason = new Error("cancel the pour");
  const settling = settleFormations(bot, watchFormations(bot, cell(0, 64, 0)), controller.signal, {
    now: clock.now, sleep: (ms) => clock.sleep(ms, controller.signal),
  });
  const rejected = assert.rejects(settling, (error) => error === reason);
  controller.abort(reason);
  await rejected;
  assert.equal(clock.pendingTimers(), 0);
});
