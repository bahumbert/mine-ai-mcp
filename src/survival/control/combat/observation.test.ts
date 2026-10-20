import minecraftData from "minecraft-data";
import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { observeCombatDecision } from "./observation.js";

/** A bot alone on dry ground, hurt enough that hiding is the policy's answer to a threat. */
function loneBot(body: Record<string, unknown> = {}): Bot {
  return {
    health: 6,
    food: 20,
    game: { gameMode: "survival", dimension: "overworld" },
    heldItem: null,
    time: { timeOfDay: 18_000 },
    blockAt: () => ({ skyLight: 0, boundingBox: "block" }),
    world: { raycast: () => null },
    inventory: { items: () => [], slots: new Array(46).fill(null) },
    registry: { entitiesByName: minecraftData("1.21.4").entitiesByName },
    entity: { id: 1, width: 0.6, height: 1.8, position: new Vec3(0, 0, 0), ...body },
    entities: {},
  } as unknown as Bot;
}

test("hiding is allowed on dry ground", () => {
  assert.equal(observeCombatDecision(loneBot()).hideAllowed, true);
});

test("hiding is not allowed while the body is in water", () => {
  assert.equal(observeCombatDecision(loneBot({ isInWater: true })).hideAllowed, false);
});

test("hiding is not allowed while the body is in lava", () => {
  assert.equal(observeCombatDecision(loneBot({ isInLava: true })).hideAllowed, false);
});
