/** Mining retries an unobserved cast from the same stance after the server clock resumes. */
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { setCarriedCount } from "../../../test-support/carried-counts.js";
import { createFakeBot, createFakeClock, type FakeHarness } from "../../../test-support/fake-bot/index.js";
import { mine, type MineRequest } from "./mine-process.js";

/** Inventory packets after bucket uses, as in mine-process.test.ts and contract pour-through-lava. */
function swapBucket(scene: FakeHarness, from: string, to: string): void {
  setCarriedCount(scene.inventory, scene.bot.registry, scene.bot.registry.itemsByName[from]!.id, 0);
  setCarriedCount(scene.inventory, scene.bot.registry, scene.bot.registry.itemsByName[to]!.id, 1);
}

for (const rate of [5, 10]) for (const touching of [false, true]) {
  test(`a stopped-clock ${touching ? "touching-source" : "pool"} cast at ${rate} tps retries without sealing or losing its stance`, async () => {
    const clock = createFakeClock({ mode: "mocked" });
    using _timers = clock.install();
    const scene = createFakeBot({
      clock, groundY: null, server: { ticksPerSecond: rate }, carried: { water_bucket: 1 },
      position: new Vec3(0.5, touching ? 64 : 65, 0.5),
      cells: {
        "0,63,0": "dirt", "0,64,0": touching ? "air" : "dirt",
        "1,63,0": "dirt", "2,63,0": "dirt",
        "1,64,0": touching ? "obsidian" : "lava", "2,64,0": "lava",
      },
    });
    scene.bot.entity.onGround = true;
    const stances: Vec3[] = [];
    let landing: Vec3 | null = null;
    let broken = 0;
    let stoppedAge = 0;
    const request: MineRequest = {
      matches: (block) => block.name === "obsidian",
      matchingStateIds: new Set([scene.bot.registry.blocksByName.obsidian!.defaultState!]),
      canMine: () => ({ kind: "mineable", routeMayBreak: false }), collects: () => true,
      isSatisfied: () => broken > 0, observedInventoryGain: () => broken,
      movements: {} as MineRequest["movements"], castSearchRadius: 64, explore: false, maximumBreaks: 4,
      placeInto: async () => { throw new Error("an unanswered cast must not seal the lava"); },
      cast: async (_bot, use) => {
        if (use.item.name === "water_bucket") {
          stances.push(scene.bot.entity.position.clone());
          swapBucket(scene, "water_bucket", "bucket");
          for (const cell of use.expectedCells ?? []) {
            landing = new Vec3(cell.position.x, cell.position.y, cell.position.z);
            scene.world.setCell(landing, "water");
          }
          if (stances.length === 1) { stoppedAge = scene.bot.time.age; scene.server.stop(); }
          else {
            scene.world.setCell(new Vec3(1, 64, 0), "obsidian");
            scene.world.setCell(new Vec3(2, 64, 0), "obsidian");
          }
        } else {
          // The server resumes after the unanswered count, before handling the scoop.
          if (stances.length === 1) assert.equal(scene.bot.time.age, stoppedAge);
          else assert.equal(scene.bot.time.age, stoppedAge + 40);
          scene.server.resume();
          swapBucket(scene, "bucket", "water_bucket");
          if (landing) scene.world.setCell(landing, "air");
        }
        return { kind: "used" };
      },
      breakInPlace: async ({ position }) => {
        assert.ok(stances.length >= 2, "the source must be recast before mining");
        scene.world.setCell(new Vec3(position.x, position.y, position.z), "air");
        broken += 1;
        return { status: "broken" };
      },
      route: async () => {
        assert.equal(stances.length, 2, "no movement before the same stance casts again");
        scene.bot.entity.position = new Vec3(1.5, 65, 0.5);
        return { status: "completed", elapsedMs: 0 };
      },
    };
    const result = await clock.settle(mine(scene.bot, request), 40_000);
    assert.equal(result.status, "satisfied");
    assert.deepEqual(stances, [stances[0], stances[0]], "resumed cast uses the original stance");
  });
}
