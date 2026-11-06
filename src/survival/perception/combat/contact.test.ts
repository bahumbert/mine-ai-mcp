import assert from "node:assert/strict";
import test from "node:test";
import { createFakeBot, itemOf } from "../../../test-support/fake-bot/index.js";
import { watchServerTags } from "../../../world/server-tags.js";
import { isDrawingBow } from "./attention.js";
import { defendsOnContact } from "./contact.js";
import { isRangedAttacker, positionThreat } from "./observations.js";

function zombieHolding(held: string | null) {
  const harness = createFakeBot({ position: { x: 0, y: 64, z: 0 }, entities: { 31: { name: "zombie", position: { x: 0, y: 64, z: 4 } } } });
  watchServerTags(harness.bot);
  const zombie = harness.bot.entities[31]!;
  if (held !== null) zombie.setEquipment(0, itemOf(harness.bot.registry, held));
  return { ...harness, zombie };
}

test("a mob holding a crossbow or a bow is ranged: it does not defend on contact and its position threat is a projectile", () => {
  for (const held of ["crossbow", "bow"]) {
    const { bot, zombie } = zombieHolding(held);
    assert.equal(defendsOnContact(bot, zombie), false, held);
    assert.equal(positionThreat(bot, zombie).attack, "projectile", held);
  }
});

test("a mob holding a sword or nothing is not ranged", () => {
  for (const held of ["iron_sword", null]) {
    const { bot, zombie } = zombieHolding(held);
    assert.equal(defendsOnContact(bot, zombie), true, String(held));
    assert.equal(isRangedAttacker(bot, zombie), false, String(held));
    assert.notEqual(positionThreat(bot, zombie).attack, "projectile", String(held));
  }
});

test("an item a datapack adds to the crossbow or bow family makes its holder ranged; only a bow holder draws", () => {
  for (const [tag, draws] of [["minecraft:enchantable/crossbow", false], ["minecraft:enchantable/bow", true]] as const) {
    const { bot, zombie, emitTags } = zombieHolding("stick");
    const flagsIndex = bot.registry.entitiesByName.zombie!.metadataKeys!.indexOf("living_entity_flags");
    (zombie.metadata as unknown[])[flagsIndex] = 1; // the "using item" flag: the mob is drawing what it holds
    assert.equal(defendsOnContact(bot, zombie), true, "a stick is no shooter yet");
    assert.equal(isDrawingBow(bot, zombie), false);
    emitTags([{ tagType: "minecraft:item", tags: [{ tagName: tag, entries: [bot.registry.itemsByName.stick!.id] }] }]);
    assert.equal(defendsOnContact(bot, zombie), false, tag);
    assert.equal(positionThreat(bot, zombie).attack, "projectile", tag);
    assert.equal(isRangedAttacker(bot, zombie), draws, tag);
    assert.equal(isDrawingBow(bot, zombie), draws, tag);
  }
});
