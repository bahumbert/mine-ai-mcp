/**
 * Measured 2026-11-08 on 1.21.4 in two flat-world trials: WORLD_SURFACE and MOTION_BLOCKING,
 * both long arrays of 37 longs, 9-bit entries packed seven per long from low bits, first air
 * above relative to minY; each matched the loaded column in 8/8 varied-height samples in both trials.
 * The shared fake sends no map_chunk packet or heightmap.
 */
import assert from "node:assert/strict";
import { Vec3 } from "vec3";
import type { Bot } from "mineflayer";
import type { ContractCheck } from "../checks.ts";
import { answerArrives, serverQuiet } from "../server-answer.ts";

type Longs = readonly (readonly [number, number])[];
type Heightmaps = { readonly type: string; readonly value: Record<string, { readonly type: string; readonly value: Longs }> };

/** Decode a 1.21.4 heightmap entry, in absolute first-air-above coordinates. */
export function decodeHeight(longs: Longs, index: number, minY: number): number {
  const [high, low] = longs[Math.floor(index / 7)]!;
  const word = (BigInt(high >>> 0) << 32n) | BigInt(low >>> 0);
  return minY + Number((word >> BigInt((index % 7) * 9)) & 511n);
}

/** Read the first non-air cell from the top of a loaded column. */
function firstAirAbove(bot: Bot, x: number, z: number, minY: number, height: number): number {
  for (let y = minY + height - 1; y >= minY; y--) {
    const block = bot.blockAt(new Vec3(x, y, z));
    assert.ok(block, `unloaded column at ${x},${y},${z}`);
    if (block.name !== "air" && block.name !== "cave_air" && block.name !== "void_air") return y + 1;
  }
  return minY;
}

/** Compare the packet's two heightmaps with eight cells in the loaded chunk. */
function measure(bot: Bot, chunkX: number, chunkZ: number, raw: unknown): string {
  const maps = raw as Heightmaps;
  assert.equal(maps.type, "compound");
  const { minY, height } = bot.game as typeof bot.game & { minY: number; height: number };
  const names = ["WORLD_SURFACE", "MOTION_BLOCKING"] as const;
  const matches = names.map((name) => {
    const map = maps.value[name];
    assert.equal(map?.type, "longArray", `${name} type`);
    assert.equal(map.value.length, 37, `${name} long count`);
    let count = 0;
    for (const [x, z] of [[0, 1], [1, 1], [2, 1], [3, 1], [4, 1], [5, 1], [0, 2], [1, 2]] as const) {
      const actual = firstAirAbove(bot, chunkX * 16 + x, chunkZ * 16 + z, minY, height);
      if (decodeHeight(map.value, z * 16 + x, minY) === actual) count++;
    }
    assert.equal(count, 8, `${name} columns matching the loaded world`);
    return `${name} ${count}/8`;
  });
  return `MEASURED types ${Object.keys(maps.value).join(",")}; packing 37 longs, 9 bits, 7 entries per long low first, first air above relative to minY; ${matches.join("; ")}`;
}

export const heightmapInChunkPacket: ContractCheck = {
  name: "heightmap-in-chunk-packet",
  fixture: { cells: { "0,-60,1": "stone", "1,-59,1": "stone", "2,-58,1": "stone", "3,-57,1": "stone", "4,-56,1": "stone", "5,-55,1": "stone", "0,-59,2": "stone", "1,-57,2": "stone" }, carried: {}, position: [0.5, -60, 0.5] },
  withoutRuntime: true,
  exclusive: "The check teleports outside the lane to reload its chunk",
  async run(subject) {
    const { bot } = subject;
    if (subject.chunkPackets === "not-simulated") {
      let packets = 0;
      const onChunk = () => { packets++; };
      bot._client.on("map_chunk", onChunk);
      try {
        await serverQuiet(subject, "fake chunk packets");
        assert.equal(packets, 0);
        return "MEASURED fake: no heightmap";
      } finally {
        bot._client.off("map_chunk", onChunk);
      }
    }
    const position = bot.entity.position.clone();
    const chunkX = Math.floor(position.x) >> 4;
    const chunkZ = Math.floor(position.z) >> 4;
    let packet: { x: number; z: number; heightmaps: unknown } | undefined;
    const onChunk = (incoming: { x: number; z: number; heightmaps: unknown }) => {
      if (incoming.x === chunkX && incoming.z === chunkZ) packet = incoming;
    };
    bot._client.on("map_chunk", onChunk);
    try {
      bot.chat(`/tp @s ${position.x + 600} ${position.y} ${position.z}`);
      await answerArrives(subject, () => bot.entity.position.x > position.x + 500, "teleport away");
      bot.chat(`/tp @s ${position.x} ${position.y} ${position.z}`);
      await answerArrives(subject, () => packet !== undefined, "the feet chunk after teleport back");
      return measure(bot, chunkX, chunkZ, packet!.heightmaps);
    } finally {
      bot._client.off("map_chunk", onChunk);
    }
  },
};
