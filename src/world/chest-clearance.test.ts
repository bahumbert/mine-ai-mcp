import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot } from "../test-support/fake-bot/index.js";
import { chestOpeningObstruction } from "./chest-clearance.js";

test("chest clearance distinguishes deepslate from transparent and partial blocks", () => {
  const at = new Vec3(-115, -50, 9);
  for (const name of ["deepslate", "air", "glass", "oak_slab"]) {
    // Only the cell above the chest is read: every read is checked against it.
    const { bot } = createFakeBot({ position: at.offset(0.5, 0, 0.5), cells: { "-115,-49,9": name } });
    const read = bot.blockAt;
    bot.blockAt = (cell) => {
      assert.equal(cell.y, -49);
      return read(cell);
    };
    const error = chestOpeningObstruction(bot, "chest", at);
    if (name === "deepslate") assert.match(error ?? "", /CHEST_BLOCKED.*deepslate/);
    else assert.equal(error, null);
    assert.equal(chestOpeningObstruction(bot, "barrel", at), null);
  }
});
