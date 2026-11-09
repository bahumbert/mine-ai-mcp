import assert from "node:assert/strict";
import test from "node:test";
import { createFakeBot, itemOf } from "../../../test-support/fake-bot/index.js";
import { watchServerTags } from "../../../world/server-tags.js";
import { isDrawingBow } from "./attention.js";
import { defendsOnContact } from "./contact.js";
import { isRangedAttacker, positionThreat } from "./observations.js";

function zombieHolding(held: string | null, version = "1.21.4") {
  const harness = createFakeBot({ version, position: { x: 0, y: 64, z: 0 }, entities: { 31: { name: "zombie", position: { x: 0, y: 64, z: 4 } } } });
  watchServerTags(harness.bot);
  const zombie = harness.bot.entities[31]!;
  if (held !== null) zombie.setEquipment(0, itemOf(harness.bot.registry, held));
  return { ...harness, zombie };
}

test("trident, crossbow and bow holders are ranged at all three reads; sword and empty hands are melee", () => {
  for (const version of ["1.19.4", "1.20.1", "1.20.4", "1.20.6", "1.21.1", "1.21.4"]) {
    for (const [held, ranged] of [["trident", true], ["crossbow", true], ["bow", true], ["iron_sword", false], [null, false]] as const) {
      const { bot, zombie } = zombieHolding(held, version);
      assert.equal(defendsOnContact(bot, zombie), !ranged, `${held} ${version}`);
      assert.equal(isRangedAttacker(bot, zombie), ranged, `${held} ${version}`);
      assert.equal(positionThreat(bot, zombie).attack, ranged ? "projectile" : "melee", `${held} ${version}`);
    }
  }
});

test("datapack ranged weapons update all three reads; only a bow holder draws", () => {
  for (const [tag, draws] of [["minecraft:enchantable/crossbow", false], ["minecraft:enchantable/bow", true], ["minecraft:enchantable/trident", false]] as const) {
    const { bot, zombie, emitTags } = zombieHolding("stick");
    const flagsIndex = bot.registry.entitiesByName.zombie!.metadataKeys!.indexOf("living_entity_flags");
    (zombie.metadata as unknown[])[flagsIndex] = 1; // the "using item" flag: the mob is drawing what it holds
    assert.equal(defendsOnContact(bot, zombie), true, "a stick is no shooter yet");
    assert.equal(isDrawingBow(bot, zombie), false);
    emitTags([{ tagType: "minecraft:item", tags: [{ tagName: tag, entries: [bot.registry.itemsByName.stick!.id] }] }]);
    assert.equal(defendsOnContact(bot, zombie), false, tag);
    assert.equal(positionThreat(bot, zombie).attack, "projectile", tag);
    assert.equal(isRangedAttacker(bot, zombie), true, tag);
    assert.equal(isDrawingBow(bot, zombie), draws, tag);
  }
});
