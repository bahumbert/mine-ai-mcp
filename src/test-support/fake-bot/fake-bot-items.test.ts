import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot } from "./fake-bot.js";

test("an entity is filed under its minecraft-data category, as Mineflayer files it, and an unknown kind as unknown", () => {
  // Mineflayer `entities.js:184` sets `entity.kind = entityData.category`, `:193` "unknown" when the type has no data.
  const { bot } = createFakeBot({
    entities: {
      7: { name: "zombie", position: new Vec3(3, 64, 0) },
      8: { name: "cow", position: new Vec3(-3, 64, 0) },
      9: { name: "no_such_mob", position: new Vec3(0, 64, 3) },
    },
  });
  assert.equal(bot.entities[7]!.kind, bot.registry.entitiesByName.zombie!.category);
  assert.equal(bot.entities[7]!.kind, "Hostile mobs");
  assert.equal(bot.entities[8]!.kind, "Passive mobs");
  assert.equal(bot.entities[9]!.kind, "unknown");
});

test("a test's own kind for an entity wins over the category", () => {
  const { bot } = createFakeBot({ entities: { 7: { name: "player", kind: undefined, position: new Vec3(3, 64, 0) } } });
  assert.equal(bot.entities[7]!.kind, undefined);
});
