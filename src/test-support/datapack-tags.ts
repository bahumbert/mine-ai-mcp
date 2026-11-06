import type { FakeHarness } from "./fake-bot/index.js";
import { watchServerTags } from "../world/server-tags.js";

/**
 * A datapack adds vanilla items to a vanilla item tag (`swords`): the server's `tags` packet reaches the bot, as the
 * runtime host's `watchServerTags` listens for it. A family test uses it for "another member of the family".
 */
export function addItemsToServerTag(harness: FakeHarness, tag: string, itemNames: readonly string[]): void {
  const { bot } = harness;
  watchServerTags(bot);
  const entries = itemNames.map((name) => bot.registry.itemsByName[name]!.id);
  harness.emitTags([{ tagType: "minecraft:item", tags: [{ tagName: `minecraft:${tag}`, entries }] }]);
}
