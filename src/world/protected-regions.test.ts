import assert from "node:assert/strict";
import test from "node:test";
import { createFakeBot } from "../test-support/fake-bot/index.js";
import {
  anyRegionAt,
  cellsOutsideRegionsFirst,
  describeProtectedRegion,
  foreignRegionAt,
  protectedRegionAt,
  regionRefusalText,
  setProtectedRegionsProvider,
  type ProtectedRegion,
} from "./protected-regions.js";

const house: ProtectedRegion = {
  regionId: 1, dimension: "overworld", min: { x: 0, y: 63, z: 0 }, max: { x: 6, y: 70, z: 4 }, owner: "Ayla", label: "small medieval house",
};

test("a region holds its cells inclusively, in its own dimension only", () => {
  assert.equal(protectedRegionAt([house], "overworld", 0, 63, 0), house);
  assert.equal(protectedRegionAt([house], "overworld", 6, 70, 4), house);
  assert.equal(protectedRegionAt([house], "overworld", 7, 70, 4), null);
  assert.equal(protectedRegionAt([house], "overworld", 3, 62, 2), null);
  assert.equal(protectedRegionAt([house], "the_nether", 3, 65, 2), null);
});

test("the owner's own build is exempt, whatever the name's case", () => {
  assert.equal(protectedRegionAt([house], "overworld", 3, 65, 2, "ayla"), null);
  assert.equal(protectedRegionAt([house], "overworld", 3, 65, 2, "Tom"), house);
  assert.equal(describeProtectedRegion(house), "protected region #1 'small medieval house' (owner Ayla)");
});

// The bot-aware reads (plan 2026-11-07-p4-06a-threat T5a): own regions never refuse a placement, others' do.
const toms: ProtectedRegion = { ...house, regionId: 2, owner: "Tom", label: "Tom's place" };
const insideHouse = { x: 3, y: 65, z: 2 };

function botWith(regions: readonly ProtectedRegion[], options: { username?: string; dimension?: string } = {}) {
  const { bot } = createFakeBot({ username: options.username ?? "Ayla", dimension: options.dimension ?? "overworld" });
  setProtectedRegionsProvider(bot, () => regions);
  return bot;
}

test("foreignRegionAt skips the bot's own region whatever the name's case, finds another owner's even behind it, and stops at the dimension", () => {
  assert.equal(foreignRegionAt(botWith([house], { username: "Ayla" }), insideHouse), null);
  assert.equal(foreignRegionAt(botWith([house], { username: "AYLA" }), insideHouse), null);
  assert.equal(foreignRegionAt(botWith([house], { username: "Tom" }), insideHouse), house);
  const nested = { ...toms, min: house.min, max: house.max };
  assert.equal(foreignRegionAt(botWith([house, nested]), insideHouse), nested);
  assert.equal(foreignRegionAt(botWith([toms], { dimension: "the_nether" }), insideHouse), null);
  assert.equal(foreignRegionAt(botWith([toms]), { x: 30, y: 65, z: 2 }), null);
});

test("anyRegionAt finds the bot's own region too, and a refusal names the region", () => {
  assert.equal(anyRegionAt(botWith([house]), insideHouse), house);
  assert.equal(anyRegionAt(botWith([]), insideHouse), null);
  assert.equal(regionRefusalText(toms), "inside protected region #2 'Tom's place' (owner Tom)");
});

test("cells outside every region come first, the bot's own region's next, a foreign one's last", () => {
  const own = { ...house, regionId: 3, min: { x: 10, y: 63, z: 0 }, max: { x: 12, y: 70, z: 4 } };
  const foreign = { ...toms, min: { x: 20, y: 63, z: 0 }, max: { x: 22, y: 70, z: 4 } };
  const bot = botWith([own, foreign]);
  const cells = [{ x: 20, y: 65, z: 1 }, { x: 11, y: 65, z: 1 }, { x: 0, y: 65, z: 1 }, { x: 1, y: 65, z: 1 }];
  assert.deepEqual(cellsOutsideRegionsFirst(bot, cells).map((cell) => cell.x), [0, 1, 11, 20]);
});
