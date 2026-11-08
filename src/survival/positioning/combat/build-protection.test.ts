import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot, createFakeClock } from "../../../test-support/fake-bot/index.js";
import { regionRefusalText, setProtectedRegionsProvider, type ProtectedRegion } from "../../../world/protected-regions.js";
import { buildProtection } from "./build-protection.js";

/** Protection walls and regions (plan 2026-11-07-p4-06a-threat T5a, ADR-012). */
const column = (x: number, owner: string, regionId: number): ProtectedRegion => ({
  regionId, dimension: "overworld", min: { x, y: 60, z: -5 }, max: { x, y: 70, z: 5 }, owner, label: "a build",
});

test("a protection wall fills the cells outside every region first, the bot's own region's next, and stops at another owner's", async () => {
  const foreign = column(1, "Tom", 8);
  const { bot, clock, server } = createFakeBot({
    username: "Ayla", gameMode: "creative", position: new Vec3(3.5, 64, 3.5), carried: { cobblestone: 8 },
    clock: createFakeClock({ mode: "mocked" }),
  });
  setProtectedRegionsProvider(bot, () => [foreign, column(0, "Ayla", 9)]);
  using _timers = clock.install();
  const cells = [new Vec3(1, 64, 0), new Vec3(0, 64, 0), new Vec3(2, 64, 0)];
  const built = await clock.settle(
    buildProtection(bot, cells, {
      signal: new AbortController().signal,
      mayContinue: () => null,
      terrain: { dig: false, place: true },
    }),
    200,
  );
  assert.equal(built.kind, "blocked");
  if (built.kind === "blocked") {
    assert.deepEqual(built.placed.map((cell) => cell.toString()), [new Vec3(2, 64, 0), new Vec3(0, 64, 0)].map((cell) => cell.toString()));
    assert.ok(built.reason.includes(regionRefusalText(foreign)), built.reason);
  }
  assert.equal(server.packets.filter((packet) => packet.name === "block_place").length, 2, "the foreign cell got no packet");
});
