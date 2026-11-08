/** Per-column revisions for readers that memoize loaded world cells. */
import type { Bot } from "mineflayer";

type Revision = (x: number, z: number) => string;
const watchers = new WeakMap<Bot, Revision>();
const key = (x: number, z: number) => `${x},${z}`;

/** Share one bot-lifetime listener set across all readers of its columns. */
export function columnRevision(bot: Bot): Revision {
  const existing = watchers.get(bot);
  if (existing) return existing;
  const columns = new Map<string, number>();
  const chunks = new Map<string, number>();
  let dimension = 0;
  bot.on("blockUpdate", (before, after) => {
    const position = (after ?? before)?.position;
    if (!position) return;
    const column = key(position.x, position.z);
    columns.set(column, (columns.get(column) ?? 0) + 1);
  });
  bot._client.on("unload_chunk", ({ chunkX, chunkZ }: { chunkX: number; chunkZ: number }) => {
    const chunk = key(chunkX, chunkZ);
    chunks.set(chunk, (chunks.get(chunk) ?? 0) + 1);
  });
  bot.on("respawn", () => { dimension++; columns.clear(); chunks.clear(); });
  const revision = (x: number, z: number) => `${dimension}/${chunks.get(key(x >> 4, z >> 4)) ?? 0}/${columns.get(key(x, z)) ?? 0}`;
  watchers.set(bot, revision);
  return revision;
}
