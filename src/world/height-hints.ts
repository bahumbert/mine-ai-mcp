/** Packet heightmaps as upper bounds for a loaded column's surface. */
import type { Bot } from "mineflayer";
import { isPassable, observeMineflayerBlock } from "../navigation/index.js";

type Longs = readonly (readonly [number, number])[];
type ChunkPacket = { x: number; z: number; heightmaps?: { value?: { WORLD_SURFACE?: { type: string; value: Longs } } } };
const stores = new WeakMap<Bot, Map<string, Int16Array>>();
const key = (x: number, z: number) => `${x},${z}`;

/** Decode the measured 1.21.4 first-air heights, seven nine-bit values per long. */
function unpack(longs: Longs, minY: number): Int16Array {
  const result = new Int16Array(256);
  for (let index = 0; index < result.length; index++) {
    const [high, low] = longs[Math.floor(index / 7)]!;
    const word = (BigInt(high >>> 0) << 32n) | BigInt(low >>> 0);
    result[index] = minY + Number((word >> BigInt((index % 7) * 9)) & 511n);
  }
  return result;
}

/** Capture packet hints and raise them when a block is placed above a hint. */
export function watchHeightHints(bot: Bot): void {
  if (stores.has(bot)) return;
  const chunks = new Map<string, Int16Array>();
  stores.set(bot, chunks);
  bot._client.on("map_chunk", (packet: ChunkPacket) => {
    const map = packet.heightmaps?.value?.WORLD_SURFACE;
    if (map?.type !== "longArray" || map.value.length !== 37) { chunks.delete(key(packet.x, packet.z)); return; }
    const { minY } = bot.game as typeof bot.game & { minY: number };
    chunks.set(key(packet.x, packet.z), unpack(map.value, minY));
  });
  bot._client.on("unload_chunk", (packet: { chunkX: number; chunkZ: number }) => { chunks.delete(key(packet.chunkX, packet.chunkZ)); });
  bot.on("blockUpdate", (_old, block) => {
    if (block === null || isPassable(observeMineflayerBlock(block))) return;
    const { x, y, z } = block.position;
    const chunk = chunks.get(key(x >> 4, z >> 4));
    if (!chunk) return;
    const index = (z & 15) * 16 + (x & 15);
    if (y >= chunk[index]!) chunk[index] = y + 1;
  });
  bot.on("respawn", () => chunks.clear());
}

/** Return the latest first-air upper bound, or null if no packet was captured. */
export function heightHint(bot: Bot): (x: number, z: number) => number | null {
  return (x, z) => stores.get(bot)?.get(key(x >> 4, z >> 4))?.[(z & 15) * 16 + (x & 15)] ?? null;
}
