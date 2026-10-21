/** Thin blocks have the game's collision shapes: a carpet 1/16 high, a single snow layer none, a fence 1.5, a slab 0.5. */
import assert from "node:assert/strict";
import { Vec3 } from "vec3";
import type { ContractCheck } from "../checks.ts";

/** Each cell, its block, and the top of its collision shapes (null: no shape at all). Apart, so the fence joins nothing. */
const SHAPES = [
  { cell: [-2, -60, 2], block: "white_carpet", top: 1 / 16 },
  { cell: [0, -60, 2], block: { name: "snow", properties: { layers: 1 } }, top: null },
  { cell: [2, -60, 2], block: "oak_fence", top: 1.5 },
  { cell: [4, -60, 2], block: { name: "stone_slab", properties: { type: "bottom" } }, top: 0.5 },
] as const;

export const thinBlockShapes: ContractCheck = {
  name: "thin-block-shapes",
  fixture: {
    cells: Object.fromEntries(SHAPES.map(({ cell, block }) => [cell.join(","), block])),
    carried: {},
    position: [0.5, -60, 0.5],
  },
  async run({ bot }) {
    for (const { cell, block, top } of SHAPES) {
      const found = bot.blockAt(new Vec3(cell[0], cell[1], cell[2]));
      const name = typeof block === "string" ? block : block.name;
      assert.equal(found?.name, name, `${cell}: ${found?.name ?? "unloaded"}, not ${name}`);
      const shapeTop = found.shapes.length === 0 ? null : Math.max(...found.shapes.map((shape) => shape[4]));
      assert.equal(shapeTop, top, `${name} at ${cell}: collision top ${shapeTop}, not ${top}`);
    }
  },
};
