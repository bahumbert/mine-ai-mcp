import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot } from "../../test-support/fake-bot/index.js";
import { setProtectedRegionsProvider } from "../../world/protected-regions.js";
import { extinguishFireAt } from "./fire-clearance.js";

/** Protected regions at the fire punch (plan 2026-11-07-p4-06a-threat T5b, ADR-012): a refused cell is "blocked", as a cell the bot cannot dig. */
const FIRE = new Vec3(1, 64, 0);
const cases = [
  { owner: "Tom", why: "fire in another owner's region is left burning: blocked, with no dig packet", result: "blocked", block: "fire", digs: false },
  { owner: "own", why: "fire in the bot's own region is punched out", result: "clear", block: "air", digs: true },
] as const;

for (const { owner, why, result, block, digs } of cases) {
  test(why, async () => {
    const harness = createFakeBot({ position: new Vec3(0.5, 64, 0.5), cells: { "1,64,0": "fire" } });
    const regionOwner = owner === "own" ? harness.bot.username : owner;
    setProtectedRegionsProvider(harness.bot, () => [
      { regionId: 8, dimension: "overworld", owner: regionOwner, label: "Tom's hall", min: { x: 0, y: 63, z: -1 }, max: { x: 2, y: 66, z: 1 } },
    ]);
    assert.equal(await harness.clock.settle(extinguishFireAt(harness.bot, FIRE, new AbortController().signal, true), 5_000), result);
    assert.equal(harness.bot.blockAt(FIRE)?.name, block);
    assert.equal(harness.server.packets.some((packet) => packet.name === "block_dig"), digs);
  });
}
