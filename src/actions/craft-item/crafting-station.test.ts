import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import type { NavigationRuntime } from "../../navigation/index.js";
import { craftingBot } from "../../test-support/crafting.js";
import { type FakeClock, createFakeBot, createFakeClock } from "../../test-support/fake-bot/index.js";
import type { WorldBlock } from "../../world/placement.js";
import { placeCarriedBlockNearby } from "../../world/index.js";
import { placedTableAt, prepareCraftingStation, reachCraftingTable, startTableHold } from "./crafting-station.js";
import { recordPlacementSent } from "../../world/own-placement.js";

const position = new Vec3(3, 64, 1);
const table = { name: "crafting_table", position } as WorldBlock;

function stationFixture(carried: Record<string, number>, clock?: FakeClock) {
  const fixture = craftingBot(carried, false, [], { clock });
  const id = fixture.bot.registry.itemsByName.crafting_table!.id;
  const placed: string[] = [];
  const place: typeof placeCarriedBlockNearby = async (_bot, _name, options) => {
    placed.push("place");
    options?.onPlacementSent?.([position]); // the real placement calls it right before the packet
    fixture.counts.set(id, (fixture.counts.get(id) ?? 0) - 1);
    return { kind: "placed" as const, position, block: table };
  };
  const hold = startTableHold();
  return { ...fixture, placed, place, hold };
}

const noItems = [] as const;

test("a table this request set down earlier is used again, never a second one placed", async () => {
  const f = stationFixture({ crafting_table: 1 });
  Object.assign(f.bot, { blockAt: () => table });
  recordPlacementSent(f.hold.own, [position], f.bot.time.age);

  const station = await prepareCraftingStation(f.bot, noItems, true, { hold: f.hold, place: f.place });

  assert.equal(station.kind, "ready");
  assert.equal(station.kind === "ready" ? station.craftingTable : null, table);
  assert.deepEqual(f.placed, []);
});

test("a table broken between attempts is replaced by the carried one, and the new place is kept", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _installed = clock.install();
  const f = stationFixture({ crafting_table: 1 }, clock);
  Object.assign(f.bot, { blockAt: () => ({ name: "air", position }) as WorldBlock });
  recordPlacementSent(f.hold.own, [new Vec3(9, 64, 9)], f.bot.time.age);

  // "The server answered": "gone" is its answer once the clock moved the world age 40 ticks (2 s) past the send.
  const station = await clock.settle(prepareCraftingStation(f.bot, noItems, true, { hold: f.hold, place: f.place }), 2_000);

  assert.equal(station.kind, "ready");
  assert.deepEqual(f.placed, ["place"]);
  assert.deepEqual(placedTableAt(f.hold), { x: 3, y: 64, z: 1 });
  assert.equal(f.hold.usedCarried, 1);
});

test("a fresh request with no table in reach places the carried one and keeps where", async () => {
  const f = stationFixture({ crafting_table: 1 });

  await prepareCraftingStation(f.bot, noItems, true, { hold: f.hold, place: f.place });

  assert.deepEqual(placedTableAt(f.hold), { x: 3, y: 64, z: 1 });
  assert.equal(f.hold.usedCarried, 1);
});

test("a table beyond reach is walked back to, and one in reach is not", async () => {
  const walks: string[] = [];
  const walking = {
    navigate: async () => {
      walks.push("walk");
      return { status: "completed", elapsedMs: 0 };
    },
  } as unknown as NavigationRuntime;
  const { bot } = createFakeBot({ position: new Vec3(0.5, 64, 0.5) });

  await reachCraftingTable(bot, walking, table, undefined);
  assert.deepEqual(walks, [], "3 blocks away is within reach");

  bot.entity.position = new Vec3(30.5, 64, 0.5);
  await reachCraftingTable(bot, walking, table, undefined);
  assert.deepEqual(walks, ["walk"]);
});

test("an abort after the table landed but before the placement answered: the next attempt uses that table", async () => {
  const f = stationFixture({ crafting_table: 1 });
  const controller = new AbortController();
  const cutOff: typeof placeCarriedBlockNearby = async (_bot, _name, options) => {
    f.placed.push("place");
    options?.onPlacementSent?.([position]);
    Object.assign(f.bot, { blockAt: () => table });
    controller.abort(new Error("reflex during the placement"));
    throw controller.signal.reason;
  };
  await assert.rejects(
    prepareCraftingStation(f.bot, noItems, true, { hold: f.hold, signal: controller.signal, place: cutOff }),
    /reflex during the placement/,
  );
  assert.deepEqual(placedTableAt(f.hold), { x: 3, y: 64, z: 1 }, "recorded at the send, before the place call could throw");

  const station = await prepareCraftingStation(f.bot, noItems, true, { hold: f.hold, place: f.place });

  assert.equal(station.kind === "ready" ? station.craftingTable : null, table);
  assert.deepEqual(f.placed, ["place"], "no second placement");
});

test("an abort before the table landed: the next attempt finds the cell empty and places the carried one", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _installed = clock.install();
  const f = stationFixture({ crafting_table: 1 }, clock);
  const controller = new AbortController();
  Object.assign(f.bot, { blockAt: () => ({ name: "air", position }) as WorldBlock });
  const cutOff: typeof placeCarriedBlockNearby = async (_bot, _name, options) => {
    options?.onPlacementSent?.([position]);
    controller.abort(new Error("reflex during the placement"));
    throw controller.signal.reason;
  };
  await assert.rejects(
    prepareCraftingStation(f.bot, noItems, true, { hold: f.hold, signal: controller.signal, place: cutOff }),
    /reflex during the placement/,
  );

  // "The server answered": the empty cell is its answer once the clock moved the world age 40 ticks (2 s) past the send.
  const station = await clock.settle(prepareCraftingStation(f.bot, noItems, true, { hold: f.hold, place: f.place }), 2_000);

  assert.equal(station.kind, "ready");
  assert.deepEqual(f.placed, ["place"]);
});

test("a table made for the batch is reported as crafted and counted as put down, so a table target is not under-credited", async () => {
  const f = stationFixture({ oak_planks: 4 });
  const crafted: Array<{ id: number; count: number }> = [];

  const station = await prepareCraftingStation(f.bot, noItems, true, {
    hold: f.hold,
    place: f.place,
    onCrafted: ({ id, count }) => crafted.push({ id, count }),
  });

  assert.equal(station.kind, "ready");
  assert.deepEqual(crafted, [{ id: f.bot.registry.itemsByName.crafting_table!.id, count: 1 }]);
  assert.equal(f.hold.usedCarried, 1, "the table it made and set down is spent: it is no gain for a table target");
});

test("a table a reflex set down in the chosen cell before the send is not ours", async () => {
  const f = stationFixture({ crafting_table: 1 });
  const controller = new AbortController();
  // Cut during the equip: the cell was chosen, nothing was sent, then a reflex puts a table in that very cell.
  const cutBeforeSend: typeof placeCarriedBlockNearby = async () => {
    controller.abort(new Error("reflex during the equip"));
    throw controller.signal.reason;
  };
  await assert.rejects(
    prepareCraftingStation(f.bot, noItems, true, { hold: f.hold, signal: controller.signal, place: cutBeforeSend }),
    /reflex during the equip/,
  );
  Object.assign(f.bot, { blockAt: () => table });
  assert.equal(placedTableAt(f.hold), undefined, "nothing was sent, so nothing is recorded");

  const station = await prepareCraftingStation(f.bot, noItems, true, { hold: f.hold, place: f.place });

  assert.equal(station.kind, "ready");
  assert.deepEqual(f.placed, ["place"], "the request placed its own table instead of taking the reflex's for it");
  assert.equal(f.hold.usedCarried, 1);
});

test("a table placed by this request in a chunk that is no longer loaded fails naming the cell, with no second table", async () => {
  const f = stationFixture({ crafting_table: 1 });
  recordPlacementSent(f.hold.own, [position], f.bot.time.age);
  Object.assign(f.bot, { blockAt: () => null });

  const station = await prepareCraftingStation(f.bot, noItems, true, { hold: f.hold, place: f.place });

  assert.equal(station.kind, "failed");
  assert.match(station.kind === "failed" ? station.error : "", /\(3, 64, 1\).*not loaded.*go back near/su);
  assert.deepEqual(f.placed, []);
});

test("two craft requests on two bots keep their own table cells", async () => {
  const first = stationFixture({ crafting_table: 1 });
  const second = stationFixture({ crafting_table: 1 });
  recordPlacementSent(first.hold.own, [position], first.bot.time.age);
  Object.assign(first.bot, { blockAt: () => table });

  // The second bot sent no placement before, so it waits for no server answer: no clock to drive.
  const firstStation = await prepareCraftingStation(first.bot, noItems, true, { hold: first.hold, place: first.place });
  const secondStation = await prepareCraftingStation(second.bot, noItems, true, { hold: second.hold, place: second.place });

  assert.equal(firstStation.kind, "ready");
  assert.equal(secondStation.kind, "ready");
  assert.deepEqual([first.placed, second.placed], [[], ["place"]], "the first bot reuses its table, the second places its own");
});
