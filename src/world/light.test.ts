import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot } from "../test-support/fake-bot/index.js";
import { lightAt } from "./light.js";

/** A prismarine column's light writer (the library ships no typings): `setSkyLight(pos, light)` makes the section of `pos` hold light data. */
type LightWritingColumn = { setSkyLight(position: Vec3, light: number): void; setBlockLight(position: Vec3, light: number): void };

test("lightAt reads the measured open-air and sealed-box values, as the client holds them", () => {
  const { bot } = createFakeBot({
    groundY: -61,
    position: new Vec3(0.5, -60, 0.5),
    cells: { "3,-60,0": "stone", "5,-60,0": "stone", "4,-61,0": "stone", "4,-59,0": "stone", "4,-60,1": "stone", "4,-60,-1": "stone" },
  });
  assert.deepEqual(lightAt(bot, new Vec3(0, -60, 0)), { sky: 15, block: 0 }, "open air at noon");
  assert.deepEqual(lightAt(bot, new Vec3(4, -60, 0)), { sky: 0, block: 0 }, "inside a closed stone box");
});

test("a cell with no light data reads null, not dark", () => {
  const { bot } = createFakeBot({ groundY: -61, position: new Vec3(0.5, -60, 0.5) });
  const column = bot.world.getColumnAt(new Vec3(0, -60, 0)) as unknown as LightWritingColumn;
  // The real client holds light sections for the ground's own section and the one above; a cell higher up is in a section the server sent none for,
  // where Prismarine answers 0 (`getSkyLight`) and the block holds that 0. The fake's block says 15 here, as for any open air in the measured range.
  column.setSkyLight(new Vec3(0, -60, 0), 15);
  column.setBlockLight(new Vec3(0, -60, 0), 1);
  assert.deepEqual(lightAt(bot, new Vec3(0, -60, 0)), { sky: 15, block: 0 }, "the section holds light data: the block's own values (open air, measured)");
  assert.deepEqual(lightAt(bot, new Vec3(0, -40, 0)), { sky: null, block: null }, "a section of a column that holds light elsewhere but none here: no data");
  assert.deepEqual(lightAt(bot, new Vec3(0, -13, 0)), { sky: null, block: null }, "a cell the fake says nothing about (undefined fields) is null too");
});

test("an unloaded cell and a solid block (unmeasured) read null", () => {
  const unloaded = createFakeBot({ loadedColumns: [] }).bot;
  assert.deepEqual(lightAt(unloaded, new Vec3(0, 0, 0)), { sky: null, block: null }, "no block: unloaded");
  const { bot } = createFakeBot({ groundY: -61, position: new Vec3(0.5, -60, 0.5) });
  assert.deepEqual(lightAt(bot, new Vec3(0, -61, 0)), { sky: null, block: null }, "stone: the fake holds no light for it");
});
