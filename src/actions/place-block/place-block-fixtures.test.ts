// The world and reflex-cut doubles the place_block test files share (place-block.test.ts, place-block-reflex.test.ts).
import assert from "node:assert/strict";
import { Vec3 } from "vec3";
import { carriedCountField } from "../../test-support/carried-counts.js";
import { type FakeClock, createFakeBot } from "../../test-support/fake-bot/index.js";
import { type PlaceBlockDependencies } from "./place-block.js";

/**
 * A bot at (0, 64, 0) on a stone floor, carrying `carried` of `carriedBlock`, with `targetName` at (2, 64, 0). A test
 * whose action waits on the server's answer (the world age, the wall bound) passes a mocked clock it installed.
 */
export function testWorld(targetName = "air", carried = 2, carriedBlock = "cobblestone", clock?: FakeClock) {
  const target = new Vec3(2, 64, 0);
  const harness = createFakeBot({
    ...(clock && { clock }),
    position: new Vec3(0, 64, 0),
    cells: { [`${target.x},${target.y},${target.z}`]: targetName },
    carried: carried > 0 ? { [carriedBlock]: carried } : {},
  });
  const { bot, world } = harness;
  const carriedCount = carriedCountField(harness, carriedBlock);
  /** What the server's own broadcast does: change the count, then say so (a slot update). */
  const takeOneFromInventory = () => {
    carriedCount.count -= 1;
  };
  /** The block the server put down at `cell`, as the block update shows it. */
  const putDown = (cell: Vec3, name = carriedBlock) => {
    world.setCell(cell, name);
    return world.blockAt(cell)!;
  };
  const dependencies: PlaceBlockDependencies = {
    createMovements: () => ({}) as never,
    navigate: async () => ({ status: "completed", elapsedMs: 0 }),
    placeBlock: async (_bot, placement) => {
      placement.onSent?.(); // the real placeBlock calls it right before the packet
      assert.deepEqual(placement.support.position, target.offset(0, -1, 0));
      assert.deepEqual(placement.face, new Vec3(0, 1, 0));
      takeOneFromInventory();
      return { kind: "placed", block: putDown(target) } as never;
    },
    placeNearby: async (_bot, _name, options) => {
      const chosen = new Vec3(1, 64, 0);
      options?.onPlacementSent?.([chosen]); // the real one calls it right before the packet
      takeOneFromInventory();
      return { kind: "placed", position: chosen, block: putDown(chosen) as never };
    },
  };
  return { harness, bot, world, putDown, carriedCount, dependencies, target, takeOneFromInventory };
}

// Reflex continuity (spec 2026-10-18, R2): a reflex that takes the body mid-placement hands it back, and the resumed
// attempt never puts down a second block.
export const cutByReflex = () => {
  const controller = new AbortController();
  controller.abort(new Error("[HUNGER] reflex"));
  return controller.signal;
};
