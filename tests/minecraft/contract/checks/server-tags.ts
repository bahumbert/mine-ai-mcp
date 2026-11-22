/** The login tags packet resolves to the vanilla 1.21.4 tag members. */
import assert from "node:assert/strict";
import itemTags from "../../../../src/world/data/item-tags/1.21.4.json" with { type: "json" };
import { serverTagsOf, type TagRegistry } from "../../../../src/world/server-tags.ts";
import type { ContractCheck } from "../checks.ts";

export const serverTags: ContractCheck = {
  name: "server-tags",
  fixture: { cells: {}, carried: {}, position: [0.5, -60, 0.5] },
  waitsForFake: "the fake sends no login tags packet: a test sends one with harness.emitTags (shape measured by this check on the real server)",
  async run({ bot }) {
    const tags = serverTagsOf(bot);
    assert.ok(tags, "login did not deliver tags");
    const members = (kind: TagRegistry, tag: string, entries: readonly { name: string }[]) =>
      entries.filter(entry => tags.tagsOf(kind, entry.name).includes(tag)).map(entry => entry.name).sort();
    assert.deepEqual(members("item", "swords", Object.values(bot.registry.items)), itemTags.tags.swords);
    assert.deepEqual(members("item", "arrows", Object.values(bot.registry.items)), itemTags.tags.arrows);
    // Server jar data/minecraft/tags/entity_type/arrows.json, 1.21.4.
    assert.deepEqual(members("entity_type", "arrows", Object.values(bot.registry.entities)), ["arrow", "spectral_arrow"]);
    assert.equal(tags.unknownEntries, 0);
  },
};
