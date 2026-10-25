/**
 * The fake bot's plugin loader and its end. `loadPlugin`, `loadPlugins` and `hasPlugin` are Mineflayer's own
 * `plugin_loader.js` run on the bot, so a real plugin (`mineflayer-tool`) installs its fields on it; `quit` is `kick.js`,
 * ending the client (`loader.js:78` `bot.end`), whose `end` the bot re-emits (`loader.js:113`); the client ends once, as
 * a socket closes once. The client's uuid is the offline-mode one a server that does not authenticate gives a player.
 */
import { createHash } from "node:crypto";
import type { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import type { Bot } from "mineflayer";
import type { FakeBot } from "./fake-bot.js";

const require = createRequire(import.meta.url);

type BotPlugin = (bot: Bot, options: object) => void;

/** The client the fake bot writes to: packets in and out, and the fields of the real one that the library and the host read. */
export type FakeClient = EventEmitter & { uuid?: string; end?: (reason?: string) => void };

/** The server's `UUIDUtil.createOfflinePlayerUUID`: the name-based (v3) uuid of `OfflinePlayer:<name>`. */
export function offlineUuidOf(username: string): string {
  const bytes = createHash("md5").update(`OfflinePlayer:${username}`).digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x30;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Give `bot` the plugin loader, `end` and `quit`; its `client` gets `end` and its uuid. */
export function attachFakePlugins(bot: FakeBot, client: FakeClient, username: string): void {
  let ended = false;
  client.uuid = offlineUuidOf(username);
  // `client.js` `end`: the socket closes once, and the client's `end` event carries the reason given.
  client.end = (reason) => {
    if (ended) return;
    ended = true;
    client.emit("end", reason ?? "socketClosed");
  };
  client.on("end", (reason: string) => bot.emit("end", reason));
  bot.end = (reason) => client.end?.(reason);
  // `loader.js:90-100`: the loader gets the createBot options; the internal plugins are the fake's own parts, not loaded here.
  const loaderOptions = { username, version: bot.version, hideErrors: true, plugins: {} };
  (require("mineflayer/lib/plugin_loader") as BotPlugin)(bot, loaderOptions);
  bot.emit("inject_allowed");
  (require("mineflayer/lib/plugins/kick") as BotPlugin)(bot, loaderOptions);
}
