// Server confirmations for cleanup tests, separate from Mineflayer's predicted air write.
import type { FakeHarness } from "./fake-bot/index.js";

/** Vanilla answers a finished dig with its cell (Mineflayer blocks.js block_change; real cleanup scenario). */
export function confirmFakeDigs({ bot, server }: Pick<FakeHarness, "bot" | "server">): void {
  bot.on("diggingCompleted", (block) => {
    server.answer(() => bot._client.emit("block_change", { location: block.position, type: 0 }));
  });
}
