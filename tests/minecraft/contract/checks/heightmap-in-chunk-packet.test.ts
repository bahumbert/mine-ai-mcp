import assert from "node:assert/strict";
import test from "node:test";
import { decodeHeight, heightmapInChunkPacket } from "./heightmap-in-chunk-packet.ts";
import { runOnFake } from "./run-on-fake.ts";

test("the fake reports that it sends no chunk heightmap", async () => {
  assert.match((await runOnFake(heightmapInChunkPacket)) ?? "", /no heightmap/u);
});

test("a fake world gaining getColumnAt does not make it a real server", async () => {
  const result = await runOnFake(heightmapInChunkPacket, {}, (subject) => {
    Object.assign(subject.bot.world, { getColumnAt: () => null });
    return subject;
  });
  assert.match(result ?? "", /no heightmap/u);
});

test("a packet emitted by the fake is not reported as no heightmap", async () => {
  await assert.rejects(runOnFake(heightmapInChunkPacket, {}, (subject, harness) => {
    harness.clock.after(50, () => subject.bot._client.emit("map_chunk", { x: 0, z: 0, heightmaps: {} }));
    return subject;
  }));
});

test("heightmap values use seven nine-bit entries per long, low bits first", () => {
  const longs = [[16810048, 537921540], [0, 537921540]] as const;
  assert.equal(decodeHeight(longs, 0, -64), -60);
  assert.equal(decodeHeight(longs, 6, -64), -60);
  assert.equal(decodeHeight(longs, 7, -64), -60);
});
