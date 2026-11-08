// Fire metadata for a body whose feet occupy lava or source water.
import type { FakeBot } from "./fake-bot.js";
import type { FakeServer } from "./fake-server.js";

/** Mirror the source-cell metadata transitions measured by water-extinguishes-burning. */
export function attachFakeFire(bot: FakeBot, server: FakeServer): void {
  server.onTick(() => {
    const block = bot.blockAt(bot.entity.position);
    if (!block || !["lava", "water"].includes(block.name) || Number(block.getProperties().level ?? 0) !== 0) return;
    const index = bot.registry.entitiesByName.player?.metadataKeys?.indexOf("shared_flags") ?? -1;
    if (index < 0) return;
    const existing: unknown = bot.entity.metadata[index];
    const flags = typeof existing === "number" ? existing : 0;
    const next = block.name === "lava" ? flags | 1 : flags & ~1;
    if (next === flags) return;
    Reflect.set(bot.entity.metadata, index, next);
    bot.emit("entityUpdate", bot.entity);
  });
}
