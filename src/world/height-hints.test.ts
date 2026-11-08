import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot } from "../test-support/fake-bot/index.js";
import { heightHint, watchHeightHints } from "./height-hints.js";
import { caveReader } from "./cave.js";

test("a packet supplies hints, block placement raises them, removal keeps the upper bound, unload drops them", () => {
  const { bot, world } = createFakeBot({ groundY: -61, position: { x: 0, y: -60, z: 0 } });
  watchHeightHints(bot);
  const hint = heightHint(bot);
  assert.equal(hint(0, 0), null);
  const words = Array.from({ length: 37 }, () => [16810048, 537921540]);
  bot._client.emit("map_chunk", { x: 0, z: 0, heightmaps: { type: "compound", value: { WORLD_SURFACE: { type: "longArray", value: words } } } });
  assert.equal(hint(0, 0), -60);
  world.setCell(new Vec3(0, -50, 0), "stone");
  assert.equal(hint(0, 0), -49);
  world.setCell(new Vec3(0, -50, 0), "air");
  assert.equal(hint(0, 0), -49);
  bot._client.emit("unload_chunk", { chunkX: 0, chunkZ: 0 });
  assert.equal(hint(0, 0), null);
});

test("a block placed above a stale hint is the surface", () => {
  const { bot, world } = createFakeBot({ groundY: -61, position: { x: 0, y: -60, z: 0 } });
  watchHeightHints(bot);
  const words = Array.from({ length: 37 }, () => [16810048, 537921540]);
  bot._client.emit("map_chunk", { x: 0, z: 0, heightmaps: { type: "compound", value: { WORLD_SURFACE: { type: "longArray", value: words } } } });
  world.setCell(new Vec3(0, -54, 0), "stone");
  assert.equal(caveReader(bot).inCave({ x: 0, y: -60, z: 0 }), true);
});
