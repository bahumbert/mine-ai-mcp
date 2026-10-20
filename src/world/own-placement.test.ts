import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { botFixture } from "../test-support/bot.js";
import { startServerClock } from "../test-support/server-clock.js";
import { awaitOwnPlacement, forgetPlacement, recordPlacementSent, startOwnPlacement } from "./own-placement.js";
import type { WorldBlock } from "./placement.js";

const cell = new Vec3(2, 64, 0);
const head = new Vec3(3, 64, 0);
const isCobble = (block: WorldBlock) => block.name === "cobblestone";

/** A bot whose world holds what `cells` says (name per "x,y,z"); a cell not in the map is air, `null` is not loaded. */
function worldBot(cells: Map<string, string | null>) {
  return botFixture({}, {
    blockAt: (position: Vec3) => {
      const name = cells.get(`${position.x},${position.y},${position.z}`);
      return name === null ? null : { name: name ?? "air", position };
    },
  });
}

test("none before a send", async () => {
  const own = startOwnPlacement();
  assert.deepEqual(await awaitOwnPlacement(worldBot(new Map()), own, isCobble), { kind: "none" });
});

test("landed on a match in any sent cell", async () => {
  const bot = worldBot(new Map([["3,64,0", "cobblestone"]]));
  const own = startOwnPlacement();
  recordPlacementSent(own, [cell, head], bot.time.age);

  const seen = await awaitOwnPlacement(bot, own, isCobble);

  assert.equal(seen.kind, "landed");
  if (seen.kind === "landed") assert.deepEqual(seen.cell, head);
});

test("a cell that is not loaded is unloaded, whatever the world age", async () => {
  const bot = worldBot(new Map([["2,64,0", null]]));
  const own = startOwnPlacement();
  recordPlacementSent(own, [cell], bot.time.age);

  assert.deepEqual(await awaitOwnPlacement(bot, own, isCobble), { kind: "unloaded", cell });
});

test("not_landed once the world age moved 40 ticks past the send", async () => {
  const bot = worldBot(new Map());
  const own = startOwnPlacement();
  recordPlacementSent(own, [cell], bot.time.age);
  const stopClock = startServerClock(bot);

  const seen = await awaitOwnPlacement(bot, own, isCobble);
  stopClock();

  assert.deepEqual(seen, { kind: "not_landed" });
  assert.ok(bot.time.age >= 24_040);
});

test("the wait counts from the send: 40 ticks already past is answered at once", async () => {
  const bot = worldBot(new Map());
  const own = startOwnPlacement();
  recordPlacementSent(own, [cell], bot.time.age - 40);
  const started = Date.now();

  assert.deepEqual(await awaitOwnPlacement(bot, own, isCobble), { kind: "not_landed" });
  assert.ok(Date.now() - started < 200);
});

test("a block that lands while the server is behind is landed, not a second placement", async () => {
  const cells = new Map<string, string | null>();
  const bot = worldBot(cells);
  const own = startOwnPlacement();
  recordPlacementSent(own, [cell], bot.time.age);
  setTimeout(() => cells.set("2,64,0", "cobblestone"), 150);

  assert.equal((await awaitOwnPlacement(bot, own, isCobble)).kind, "landed");
});

test("wall bound when the server clock stops", async () => {
  const bot = worldBot(new Map());
  const own = startOwnPlacement();
  recordPlacementSent(own, [cell], bot.time.age);
  const started = Date.now();

  const seen = await awaitOwnPlacement(bot, own, isCobble, undefined, 120);

  assert.deepEqual(seen, { kind: "not_landed" });
  assert.ok(Date.now() - started >= 100 && Date.now() - started < 1_500);
});

test("the abort signal ends the wait", async () => {
  const bot = worldBot(new Map());
  const own = startOwnPlacement();
  recordPlacementSent(own, [cell], bot.time.age);
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error("cut")), 50);

  await assert.rejects(awaitOwnPlacement(bot, own, isCobble, controller.signal), /cut/);
});

test("forgotten placements are none again, and a second send replaces the first", async () => {
  const bot = worldBot(new Map([["2,64,0", "cobblestone"]]));
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
  const bot = worldBot(new Map([["2,64,0", "cobblestone"]]));
  recordPlacementSent(first, [cell], bot.time.age);
  recordPlacementSent(second, [head], bot.time.age);
  const stopClock = startServerClock(bot);

  assert.equal((await awaitOwnPlacement(bot, first, isCobble)).kind, "landed");
  assert.equal((await awaitOwnPlacement(bot, second, isCobble)).kind, "not_landed");
  stopClock();
});
