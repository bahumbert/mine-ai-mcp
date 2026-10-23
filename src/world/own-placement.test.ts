import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { type FakeCell, createFakeBot, createFakeClock } from "../test-support/fake-bot/index.js";
import { watch } from "../test-support/pending.js";
import { awaitOwnPlacement, forgetPlacement, recordPlacementSent, startOwnPlacement } from "./own-placement.js";
import type { WorldBlock } from "./placement.js";

const cell = new Vec3(2, 64, 0);
const head = new Vec3(3, 64, 0);
const isCobble = (block: WorldBlock) => block.name === "cobblestone";

/** A bot whose world holds `cells` (air elsewhere above the ground, `"void"` not loaded), its clock driving the timers. */
function worldBot(cells: Record<string, FakeCell> = {}) {
  return createFakeBot({ clock: createFakeClock({ mode: "mocked" }), cells });
}

/** Two time packets, one a second (contract check `world-age-per-second`): the 40 ticks past a send. */
const TWO_TIME_PACKETS_MS = 2_000;

test("none before a send", async () => {
  const { bot } = worldBot();
  const own = startOwnPlacement();
  assert.deepEqual(await awaitOwnPlacement(bot, own, isCobble), { kind: "none" });
});

test("landed on a match in any sent cell", async () => {
  const { bot } = worldBot({ "3,64,0": "cobblestone" });
  const own = startOwnPlacement();
  recordPlacementSent(own, [cell, head], bot.time.age);

  const seen = await awaitOwnPlacement(bot, own, isCobble);

  assert.equal(seen.kind, "landed");
  if (seen.kind === "landed") assert.deepEqual(seen.cell, head);
});

test("a cell that is not loaded is unloaded, whatever the world age", async () => {
  const { bot } = worldBot({ "2,64,0": "void" });
  const own = startOwnPlacement();
  recordPlacementSent(own, [cell], bot.time.age);

  assert.deepEqual(await awaitOwnPlacement(bot, own, isCobble), { kind: "unloaded", cell });
});

test("not_landed once the world age moved 40 ticks past the send", async () => {
  const { bot, clock } = worldBot();
  using _timers = clock.install();
  const own = startOwnPlacement();
  recordPlacementSent(own, [cell], bot.time.age);

  const seen = await clock.settle(awaitOwnPlacement(bot, own, isCobble), TWO_TIME_PACKETS_MS);

  assert.deepEqual(seen, { kind: "not_landed" });
  assert.ok(bot.time.age >= 24_040);
});

test("the wait counts from the send: 40 ticks already past is answered at once", async () => {
  const { bot, clock } = worldBot();
  using _timers = clock.install();
  const own = startOwnPlacement();
  recordPlacementSent(own, [cell], bot.time.age - 40);

  assert.deepEqual(await clock.settle(awaitOwnPlacement(bot, own, isCobble), 0), { kind: "not_landed" });
});

test("a block that lands while the server is behind is landed, not a second placement", async () => {
  const { bot, clock, world } = worldBot();
  using _timers = clock.install();
  const own = startOwnPlacement();
  recordPlacementSent(own, [cell], bot.time.age);
  clock.after(150, () => world.setCell(cell, "cobblestone"));

  assert.equal((await clock.settle(awaitOwnPlacement(bot, own, isCobble), 200)).kind, "landed");
});

test("wall bound when the server clock stops", async () => {
  const { bot, clock, server } = worldBot();
  using _timers = clock.install();
  server.stop();
  const own = startOwnPlacement();
  recordPlacementSent(own, [cell], bot.time.age);
  const waiting = awaitOwnPlacement(bot, own, isCobble, undefined, 120);
  const over = watch(waiting);

  await clock.advance(100);
  assert.equal(over.over, false, "still waiting before the 120 ms wall bound");
  const seen = await clock.settle(waiting, 50);

  assert.deepEqual(seen, { kind: "not_landed" });
});

test("the abort signal ends the wait", async () => {
  const { bot, clock } = worldBot();
  using _timers = clock.install();
  const own = startOwnPlacement();
  recordPlacementSent(own, [cell], bot.time.age);
  const controller = new AbortController();
  clock.after(50, () => controller.abort(new Error("cut")));

  await assert.rejects(clock.settle(awaitOwnPlacement(bot, own, isCobble, controller.signal), 100), /cut/);
});

test("forgotten placements are none again, and a second send replaces the first", async () => {
  const { bot } = worldBot({ "2,64,0": "cobblestone" });
  const own = startOwnPlacement();
  recordPlacementSent(own, [cell], bot.time.age);
  forgetPlacement(own);
  assert.deepEqual(await awaitOwnPlacement(bot, own, isCobble), { kind: "none" });

  recordPlacementSent(own, [head], bot.time.age);
  recordPlacementSent(own, [cell], bot.time.age);
  assert.deepEqual(own.cells, [cell]);
});

test("two records on two requests keep their own cells", async () => {
  const first = startOwnPlacement();
  const second = startOwnPlacement();
  const { bot, clock } = worldBot({ "2,64,0": "cobblestone" });
  using _timers = clock.install();
  recordPlacementSent(first, [cell], bot.time.age);
  recordPlacementSent(second, [head], bot.time.age);

  assert.equal((await awaitOwnPlacement(bot, first, isCobble)).kind, "landed");
  assert.equal((await clock.settle(awaitOwnPlacement(bot, second, isCobble), TWO_TIME_PACKETS_MS)).kind, "not_landed");
});
