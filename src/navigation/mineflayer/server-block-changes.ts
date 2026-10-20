/**
 * What the server itself said about its blocks: its `block_change`, `multi_block_change` and `map_chunk` packets.
 *
 * Mineflayer writes its own world too: when a dig timer ends it sets the cell to air and emits `blockUpdate` at once
 * (`digging.js:150-161`), whether or not the server broke the block. That event is a guess, not an answer (run 16, ghost
 * air: four bots held in the air over cells the server kept solid). Whoever needs to know that the server changed a cell
 * listens here, never to `blockUpdate`.
 */
import type { Bot } from "mineflayer";
import { waitForWorldAge, type WorldAgeOptions } from "../../world/world-age.js";
import type { Position3 } from "../world/world.js";

/** A cell the server named, or a whole column it sent again (every cell of the column is then the server's answer). */
export type ServerBlockChange =
  | { readonly kind: "cell"; readonly x: number; readonly y: number; readonly z: number }
  | { readonly kind: "column"; readonly chunkX: number; readonly chunkZ: number };

export function changeCovers(change: ServerBlockChange, cell: Position3): boolean {
  return change.kind === "cell"
    ? change.x === cell.x && change.y === cell.y && change.z === cell.z
    : change.chunkX === cell.x >> 4 && change.chunkZ === cell.z >> 4;
}

interface BlockChangePacket {
  readonly location: Position3;
}
interface MultiBlockChangePacket {
  readonly records: readonly (number | { readonly horizontalPos: number; readonly y: number })[];
  readonly chunkCoordinates?: Position3;
  readonly chunkX?: number;
  readonly chunkZ?: number;
}
interface MapChunkPacket {
  readonly x: number;
  readonly z: number;
}

/** The cells a `multi_block_change` lists, in the two layouts Mineflayer reads (`blocks.js:363-390`). */
function multiBlockCells(bot: Pick<Bot, "supportFeature">, packet: MultiBlockChangePacket): ServerBlockChange[] {
  const singleLong = bot.supportFeature("usesMultiblockSingleLong");
  const section = bot.supportFeature("usesMultiblock3DChunkCoords") && packet.chunkCoordinates
    ? packet.chunkCoordinates
    : { x: packet.chunkX ?? 0, y: 0, z: packet.chunkZ ?? 0 };
  return packet.records.map((record) => {
    const [cellX, cellY, cellZ] =
      typeof record === "number" && singleLong
        ? [(record >> 8) & 0x0f, record & 0x0f, (record >> 4) & 0x0f]
        : typeof record === "object"
          ? [(record.horizontalPos >> 4) & 0x0f, record.y, record.horizontalPos & 0x0f]
          : [0, 0, 0];
    return { kind: "cell", x: section.x * 16 + cellX, y: section.y * 16 + cellY, z: section.z * 16 + cellZ };
  });
}

/** Calls `listener` for every block the server changes; the returned function stops it and is safe to call twice. */
export function subscribeServerBlockChanges(
  bot: Pick<Bot, "_client" | "supportFeature">,
  listener: (change: ServerBlockChange) => void,
): () => void {
  const client = bot._client;
  const onBlockChange = (packet: BlockChangePacket) =>
    listener({ kind: "cell", x: packet.location.x, y: packet.location.y, z: packet.location.z });
  const onMultiBlockChange = (packet: MultiBlockChangePacket) => {
    for (const change of multiBlockCells(bot, packet)) listener(change);
  };
  const onMapChunk = (packet: MapChunkPacket) => listener({ kind: "column", chunkX: packet.x, chunkZ: packet.z });
  client.on("block_change", onBlockChange);
  client.on("multi_block_change", onMultiBlockChange);
  client.on("map_chunk", onMapChunk);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    client.off("block_change", onBlockChange);
    client.off("multi_block_change", onMultiBlockChange);
    client.off("map_chunk", onMapChunk);
  };
}

/** The server's clock moving this far past a request without a packet for the cell means none is coming. */
export const SERVER_ANSWER_TICKS = 40;
/** The same bound on the monotonic wall clock, for a server whose clock has stopped. */
export const SERVER_ANSWER_WALL_MS = 2_000;

export interface ServerChangeWatch {
  /** True once the server has changed the watched cell (even before this was asked); false after the bound, or a wall-clock one. An abort rejects with its reason. */
  answer(signal: AbortSignal, clock?: Partial<Pick<WorldAgeOptions, "now" | "sleep">>): Promise<boolean>;
  dispose(): void;
}

/**
 * Listens from now on for the server's packet about `cell`. Start it before the request that should provoke the packet
 * (a dig, a use-on-block) so a fast answer is not missed; `dispose` is safe to call twice.
 */
export function watchServerChange(bot: Pick<Bot, "_client" | "supportFeature" | "time">, cell: Position3): ServerChangeWatch {
  let answered = false;
  const unsubscribe = subscribeServerBlockChanges(bot, (change) => {
    if (changeCovers(change, cell)) answered = true;
  });
  return {
    answer: async (signal, clock = {}) => {
      await waitForWorldAge(bot, SERVER_ANSWER_TICKS, { wallMs: SERVER_ANSWER_WALL_MS, signal, until: () => answered, ...clock });
      return answered;
    },
    dispose: unsubscribe,
  };
}
