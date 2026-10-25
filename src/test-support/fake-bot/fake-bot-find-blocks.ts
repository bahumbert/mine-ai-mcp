/** `bot.findBlocks` and `bot.findBlock` as Mineflayer's own plugin answers them, read over the fake world's columns. */
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import type { Bot } from "mineflayer";
import type { FakeBot } from "./fake-bot.js";

const require = createRequire(import.meta.url);

type BlocksPlugin = (scratch: object, options: { version: string; hideErrors: boolean }) => void;
type Searches = Pick<Bot, "findBlocks" | "findBlock">;

/**
 * Install `mineflayer/lib/plugins/blocks.js` (`blocks.js:116-200`, the code that walks the sections nearest first) on a
 * scratch object that borrows the bot's world, game, entity and `blockAt`, so its handlers listen on a client that
 * sends nothing and the search itself is the plugin's, not a copy of it.
 */
function installSearches(bot: FakeBot): Searches {
  // Getters, copied as getters (`Object.assign` would read them once): a world, game or entity a test replaces afterwards reaches the search.
  const borrowed = {
    registry: bot.registry,
    _client: new EventEmitter(),
    blockAt: (...args: Parameters<Bot["blockAt"]>) => bot.blockAt(...args),
    get world() {
      return bot.world;
    },
    get game() {
      return bot.game;
    },
    get entity() {
      return bot.entity;
    },
  };
  const scratch = Object.defineProperties(new EventEmitter(), Object.getOwnPropertyDescriptors(borrowed)) as EventEmitter & typeof borrowed;
  (require("mineflayer/lib/plugins/blocks.js") as BlocksPlugin)(scratch, { version: bot.version, hideErrors: true });
  // The plugin put its own `blockAt` on the scratch; the search reads the bot's, which a test may replace.
  scratch.blockAt = (...args) => bot.blockAt(...args);
  return scratch as typeof scratch & Searches;
}

/** The searches are installed at the first call: the plugin builds its own block, chunk and world classes, which most tests never need. */
export function attachFakeFindBlocks(bot: FakeBot): void {
  let installed: Searches | undefined;
  const searches = () => (installed ??= installSearches(bot));
  Object.assign(bot, {
    findBlocks: (options: Parameters<Bot["findBlocks"]>[0]) => searches().findBlocks(options),
    findBlock: (options: Parameters<Bot["findBlock"]>[0]) => searches().findBlock(options),
  });
}
