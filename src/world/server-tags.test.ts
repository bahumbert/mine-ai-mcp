/** The per-bot index of server tag packets. */
import test from "node:test";
import assert from "node:assert/strict";
import { createFakeBot } from "../test-support/fake-bot/index.js";
import { rebuildServerTags, serverTagsOf, watchServerTags } from "./server-tags.js";

test("no packet yet: serverTagsOf is null, and watching twice listens once", () => {
  const { bot } = createFakeBot();
  watchServerTags(bot);
  watchServerTags(bot);
  assert.equal(serverTagsOf(bot), null);
  assert.equal(bot._client.listenerCount("tags"), 1);
});

test("configuration packet indexes item names, preserves datapack namespaces and ignores unused registries", () => {
  const harness = createFakeBot();
  watchServerTags(harness.bot);
  const id = harness.bot.registry.itemsByName.diamond_sword!.id;
  harness.emitTags([
    { tagType: "minecraft:item", tags: [
      { tagName: "minecraft:swords", entries: [id] }, { tagName: "mypack:blades", entries: [id] }, { tagName: "minecraft:weapons", entries: [id] },
    ] },
    // A registry the code does not read: its ids are neither indexed nor counted unknown.
    { tagType: "minecraft:fluid", tags: [{ tagName: "minecraft:water", entries: [999999] }] },
  ]);
  assert.equal(serverTagsOf(harness.bot)?.unknownEntries, 0);
  // Sorted, whatever the packet's order (neither the order sent nor its reverse).
  assert.deepEqual(serverTagsOf(harness.bot)?.tagsOf("item", "diamond_sword"), ["mypack:blades", "swords", "weapons"]);
});

test("entity_type and block registries index too", () => {
  const harness = createFakeBot();
  watchServerTags(harness.bot);
  harness.emitTags([
    { tagType: "minecraft:entity_type", tags: [{ tagName: "minecraft:arrows", entries: [harness.bot.registry.entitiesByName.arrow!.id] }] },
    { tagType: "minecraft:block", tags: [{ tagName: "minecraft:mineable/pickaxe", entries: [harness.bot.registry.blocksByName.stone!.id] }] },
  ]);
  assert.deepEqual(serverTagsOf(harness.bot)?.tagsOf("entity_type", "arrow"), ["arrows"]);
  assert.deepEqual(serverTagsOf(harness.bot)?.tagsOf("block", "stone"), ["mineable/pickaxe"]);
});

test("an unknown id is skipped and counted", () => {
  const harness = createFakeBot();
  watchServerTags(harness.bot);
  harness.emitTags([{ tagType: "minecraft:item", tags: [{ tagName: "minecraft:swords", entries: [999999] }] }]);
  assert.equal(serverTagsOf(harness.bot)?.unknownEntries, 1);
  assert.deepEqual(serverTagsOf(harness.bot)?.tagsOf("item", "diamond_sword"), []);
});

test("a second packet replaces the index and bumps revision", () => {
  const harness = createFakeBot();
  watchServerTags(harness.bot);
  const id = harness.bot.registry.itemsByName.diamond_sword!.id;
  harness.emitTags([{ tagType: "minecraft:item", tags: [{ tagName: "minecraft:swords", entries: [id] }] }]);
  const before = serverTagsOf(harness.bot)!;
  harness.emitTags([{ tagType: "minecraft:item", tags: [{ tagName: "mypack:blades", entries: [id] }] }]);
  assert.equal(serverTagsOf(harness.bot)?.revision, before.revision + 1);
  assert.deepEqual(serverTagsOf(harness.bot)?.tagsOf("item", "diamond_sword"), ["mypack:blades"]);
});

test("two bots have two indexes", () => {
  const a = createFakeBot();
  const b = createFakeBot();
  watchServerTags(a.bot); watchServerTags(b.bot);
  b.emitTags([]);
  a.emitTags([{ tagType: "minecraft:item", tags: [{ tagName: "minecraft:swords", entries: [a.bot.registry.itemsByName.diamond_sword!.id] }] }]);
  assert.deepEqual(serverTagsOf(a.bot)?.tagsOf("item", "diamond_sword"), ["swords"]);
  assert.deepEqual(serverTagsOf(b.bot)?.tagsOf("item", "diamond_sword"), []);
});

test("rebuild re-resolves kept ids", () => {
  const harness = createFakeBot();
  watchServerTags(harness.bot);
  const id = 999999;
  harness.emitTags([{ tagType: "minecraft:item", tags: [{ tagName: "mypack:blades", entries: [id] }] }]);
  const before = serverTagsOf(harness.bot)!;
  const original = harness.bot.registry.items;
  try {
    harness.bot.registry.items = { ...original, [id]: { ...harness.bot.registry.itemsByName.diamond_sword!, id, name: "new_blade" } };
    rebuildServerTags(harness.bot);
    assert.deepEqual(serverTagsOf(harness.bot)?.tagsOf("item", "new_blade"), ["mypack:blades"]);
    assert.equal(serverTagsOf(harness.bot)?.unknownEntries, 0);
    assert.equal(serverTagsOf(harness.bot)?.revision, before.revision + 1);
  } finally { harness.bot.registry.items = original; }
});

test("a packet without a tags list is ignored and keeps the previous index", () => {
  const harness = createFakeBot();
  watchServerTags(harness.bot);
  const id = harness.bot.registry.itemsByName.diamond_sword!.id;
  harness.emitTags([{ tagType: "minecraft:item", tags: [{ tagName: "minecraft:swords", entries: [id] }] }]);
  const before = serverTagsOf(harness.bot)!;
  harness.bot._client.emit("tags", {});
  assert.equal(serverTagsOf(harness.bot)?.revision, before.revision);
  assert.deepEqual(serverTagsOf(harness.bot)?.tagsOf("item", "diamond_sword"), ["swords"]);
});

// A damaged group or tag is skipped; the rest of the packet still indexes and later rebuilds still work.
const DAMAGED_PARTS: readonly [string, unknown][] = [
  ["a group whose tag list is not a list", { tagType: "minecraft:block", tags: "broken" }],
  ["a null group", null],
  ["a null tag", { tagType: "minecraft:item", tags: [null] }],
  ["a tag whose entries are not a list", { tagType: "minecraft:item", tags: [{ tagName: "minecraft:swords", entries: 7 }] }],
];
for (const [name, damaged] of DAMAGED_PARTS) {
  test(`${name} is skipped and the other groups still index`, () => {
    const harness = createFakeBot();
    watchServerTags(harness.bot);
    const id = harness.bot.registry.itemsByName.diamond_sword!.id;
    harness.bot._client.emit("tags", { tags: [damaged, { tagType: "minecraft:item", tags: [{ tagName: "minecraft:swords", entries: [id] }] }] });
    assert.deepEqual(serverTagsOf(harness.bot)?.tagsOf("item", "diamond_sword"), ["swords"]);
    rebuildServerTags(harness.bot);
    assert.deepEqual(serverTagsOf(harness.bot)?.tagsOf("item", "diamond_sword"), ["swords"]);
  });
}

test("a tag listing one id twice names the tag once", () => {
  const harness = createFakeBot();
  watchServerTags(harness.bot);
  const id = harness.bot.registry.itemsByName.diamond_sword!.id;
  harness.emitTags([{ tagType: "minecraft:item", tags: [{ tagName: "minecraft:swords", entries: [id, id] }] }]);
  assert.deepEqual(serverTagsOf(harness.bot)?.tagsOf("item", "diamond_sword"), ["swords"]);
});
