/**
 * The server's `tags` packet: one group per registry, each tag listing registry ids. Shape measured by contract check
 * `server-tags` (real 1.21.4 server, 3 runs of 2026-11-06): `{ tags: [{ tagType: "minecraft:item", tags: [{ tagName, entries }] }] }`.
 * The packet arrives in configuration state, before login, and again on `/reload`; the fake sends it when a test asks.
 */
import type { Bot } from "mineflayer";

export interface FakeTagGroup {
  /** The registry, namespaced: `minecraft:item`, `minecraft:block`, `minecraft:entity_type`. */
  readonly tagType: string;
  readonly tags: readonly { readonly tagName: string; readonly entries: readonly number[] }[];
}

export function emitFakeTags(bot: Bot, groups: readonly FakeTagGroup[]): void {
  bot._client.emit("tags", { tags: groups });
}
