import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import type { NavigationRuntime } from "../../navigation/index.js";
import { botFixture } from "../../test-support/bot.js";
import { craftingBot } from "../../test-support/crafting.js";
import type { WorldBlock } from "../../world/placement.js";
import { placeCarriedBlockNearby } from "../../world/index.js";
import { prepareCraftingStation, reachCraftingTable, type TableHold } from "./crafting-station.js";

const position = new Vec3(3, 64, 1);
const table = { name: "crafting_table", position } as WorldBlock;

function stationFixture(carried: Record<string, number>) {
  const fixture = craftingBot(carried);
  const id = fixture.bot.registry.itemsByName.crafting_table!.id;
  const placed: string[] = [];
  const place = async (_bot?: unknown, _name?: unknown, _options?: { onCellChosen?: (cell: Vec3) => void }) => {
    placed.push("place");
    fixture.counts.set(id, (fixture.counts.get(id) ?? 0) - 1);
    return { kind: "placed" as const, position, block: table };
  };
  const hold: TableHold = { placedAt: null, usedCarried: 0 };
  return { ...fixture, placed, place, hold };
}

const noItems = [] as const;

test("a table this request set down earlier is used again, never a second one placed", async () => {
  const f = stationFixture({ crafting_table: 1 });
  Object.assign(f.bot, { blockAt: () => table });
  f.hold.placedAt = { x: 3, y: 64, z: 1 };

  const station = await prepareCraftingStation(f.bot, noItems, true, { hold: f.hold, place: f.place });

  assert.equal(station.kind, "ready");
  assert.equal(station.kind === "ready" ? station.craftingTable : null, table);
  assert.deepEqual(f.placed, []);
});

test("a table broken between attempts is replaced by the carried one, and the new place is kept", async () => {
  const f = stationFixture({ crafting_table: 1 });
  Object.assign(f.bot, { blockAt: () => ({ name: "air", position }) as WorldBlock });
  f.hold.placedAt = { x: 9, y: 64, z: 9 };

  const station = await prepareCraftingStation(f.bot, noItems, true, { hold: f.hold, place: f.place });

  assert.equal(station.kind, "ready");
  assert.deepEqual(f.placed, ["place"]);
  assert.deepEqual(f.hold, { placedAt: { x: 3, y: 64, z: 1 }, usedCarried: 1 });
});

test("a fresh request with no table in reach places the carried one and keeps where", async () => {
  const f = stationFixture({ crafting_table: 1 });

  await prepareCraftingStation(f.bot, noItems, true, { hold: f.hold, place: f.place });

  assert.deepEqual(f.hold, { placedAt: { x: 3, y: 64, z: 1 }, usedCarried: 1 });
});

test("a table beyond reach is walked back to, and one in reach is not", async () => {
  const walks: string[] = [];
  const walking = {
    navigate: async () => {
      walks.push("walk");
      return { status: "completed", elapsedMs: 0 };
    },
  } as unknown as NavigationRuntime;
  const bot = botFixture({ position: new Vec3(0.5, 64, 0.5) });

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
    options?.onCellChosen?.(position);
    Object.assign(f.bot, { blockAt: () => table });
    controller.abort(new Error("reflex during the placement"));
    throw controller.signal.reason;
  };
  await assert.rejects(
    prepareCraftingStation(f.bot, noItems, true, { hold: f.hold, signal: controller.signal, place: cutOff }),
    /reflex during the placement/,
  );
  assert.deepEqual(f.hold.placedAt, { x: 3, y: 64, z: 1 }, "recorded before the place call could throw");

  const station = await prepareCraftingStation(f.bot, noItems, true, { hold: f.hold, place: f.place });

  assert.equal(station.kind === "ready" ? station.craftingTable : null, table);
  assert.deepEqual(f.placed, ["place"], "no second placement");
});

test("an abort before the table landed: the next attempt finds the cell empty and places the carried one", async () => {
  const f = stationFixture({ crafting_table: 1 });
  const controller = new AbortController();
  Object.assign(f.bot, { blockAt: () => ({ name: "air", position }) as WorldBlock });
  const cutOff: typeof placeCarriedBlockNearby = async (_bot, _name, options) => {
    options?.onCellChosen?.(position);
    controller.abort(new Error("reflex during the placement"));
    throw controller.signal.reason;
  };
  await assert.rejects(
    prepareCraftingStation(f.bot, noItems, true, { hold: f.hold, signal: controller.signal, place: cutOff }),
    /reflex during the placement/,
  );

  const station = await prepareCraftingStation(f.bot, noItems, true, { hold: f.hold, place: f.place });

  assert.equal(station.kind, "ready");
  assert.deepEqual(f.placed, ["place"]);
});
