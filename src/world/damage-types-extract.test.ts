import assert from "node:assert/strict";
import test from "node:test";
import { zip } from "../test-support/zip.js";
import { extractDamageTypes } from "./damage-types-extract.js";

const damageType = (name: string, body: Record<string, unknown>) => ({ [`data/minecraft/damage_type/${name}.json`]: JSON.stringify(body) });

// Trimmed from the 1.21.4 server jar's own damage types.
const JAR = zip({
  ...damageType("mob_attack", { exhaustion: 0.1, message_id: "mob", scaling: "when_caused_by_living_non_player" }),
  ...damageType("explosion", { exhaustion: 0.1, message_id: "explosion", scaling: "always" }),
  ...damageType("out_of_world", { exhaustion: 0, message_id: "outOfWorld", scaling: "never" }),
  "data/minecraft/tags/damage_type/is_explosion.json": JSON.stringify({ values: ["minecraft:explosion"] }),
});

test("every damage type of the jar gives its scaling, sorted by name", () => {
  assert.deepEqual(extractDamageTypes(JAR), {
    explosion: { scaling: "always" },
    mob_attack: { scaling: "when_caused_by_living_non_player" },
    out_of_world: { scaling: "never" },
  });
});

test("a damage type file with no scaling is refused by name, never given a guessed one", () => {
  const jar = zip({ ...damageType("odd", { exhaustion: 0 }) });
  assert.throws(() => extractDamageTypes(jar), /odd/u);
});

test("a jar without damage types gives none, tag files left out", () => {
  assert.deepEqual(extractDamageTypes(zip({ "data/minecraft/tags/damage_type/is_fire.json": "{}" })), {});
});
