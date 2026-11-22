import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot } from "../../test-support/fake-bot/index.js";
import { setProtectedRegionsProvider } from "../../world/protected-regions.js";
import { protectedRegion } from "../../test-support/protected-region.js";
import { clearBodyWebs } from "./web-clearance.js";

/** Protected regions at the web the body stands in (plan 2026-11-07-p4-06a-threat T5b, ADR-012): a web in another's region is left to the route. */
const cases = [
  { owner: "Tom", why: "a web in another owner's region is left whole, the one in the head cell outside it is dug", cleared: 1, feet: "cobweb" },
  { owner: "own", why: "a web in the bot's own region is dug, the head cell's too", cleared: 2, feet: "air" },
] as const;

for (const { owner, why, cleared, feet } of cases) {
  test(why, async () => {
    const harness = createFakeBot({ position: new Vec3(0.5, 64, 0.5), cells: { "0,64,0": "cobweb", "0,65,0": "cobweb" } });
    const regionOwner = owner === "own" ? harness.bot.username : owner;
    setProtectedRegionsProvider(harness.bot, () => [
      protectedRegion({ regionId: 2, dimension: "overworld", owner: regionOwner, label: "Tom's cellar", min: { x: 0, y: 64, z: 0 }, max: { x: 0, y: 64, z: 0 } }),
    ]);
    assert.equal(await harness.clock.settle(clearBodyWebs(harness.bot), 90_000), cleared);
    assert.equal(harness.bot.blockAt(new Vec3(0, 64, 0))?.name, feet);
    assert.equal(harness.bot.blockAt(new Vec3(0, 65, 0))?.name, "air");
  });
}
