/**
 * `findBlocks` returns the matching cells nearest first and stops at `count` (Mineflayer's `blocks.js:156-200`, read
 * over the columns the server sent): three gold blocks set farthest first come back nearest first.
 */
import assert from "node:assert/strict";
import { Vec3 } from "vec3";
import type { ContractCheck } from "../checks.ts";

/** Distances 2, 3 and 4 from the feet's cell (0, -60, 0), set farthest first, all in the feet's chunk. */
const NEAREST_FIRST = [new Vec3(0, -60, 2), new Vec3(3, -60, 0), new Vec3(0, -60, 4)] as const;

export const findBlocksMatching: ContractCheck = {
  name: "find-blocks-matching",
  fixture: {
    cells: Object.fromEntries([...NEAREST_FIRST].reverse().map((cell) => [`${cell.x},${cell.y},${cell.z}`, "gold_block"])),
    carried: {},
    position: [0.5, -60, 0.5],
  },
  async run({ bot }) {
    const matching = bot.registry.blocksByName.gold_block!.id;
    const found = (options: Partial<Parameters<typeof bot.findBlocks>[0]>) => bot.findBlocks({ matching, ...options }).map(String);
    const expected = NEAREST_FIRST.map(String);
    assert.deepEqual(found({ count: 10, maxDistance: 8 }), expected, "all three, nearest first");
    assert.deepEqual(found({ count: 2, maxDistance: 8 }), expected.slice(0, 2), "count 2 stops at the two nearest");
    assert.deepEqual(found({ count: 10, maxDistance: 3 }), expected.slice(0, 2), "maxDistance 3 leaves out the one at 4");
    assert.deepEqual(found({ count: 10, maxDistance: 8, point: new Vec3(0, -60, 5) }), [expected[2]!, expected[0]!, expected[1]!], "from (0, -60, 5) the nearest is the one at z 4, then z 2, then x 3");
    assert.deepEqual(bot.findBlocks({ matching: bot.registry.blocksByName.diamond_block!.id, count: 3, maxDistance: 8 }), [], "nothing else matches");
  },
};
