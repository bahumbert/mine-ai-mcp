import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot } from "../../../test-support/fake-bot/index.js";
import { observeCombatDecision } from "./observation.js";

/** A bot alone on dry ground, hurt enough that hiding is the policy's answer to a threat. */
function loneBot(body: { readonly isInWater?: boolean; readonly isInLava?: boolean } = {}): Bot {
  const { bot } = createFakeBot({ health: 6, position: new Vec3(0, 0, 0), server: { timeOfDay: 18_000 } });
  Object.assign(bot.entity, body);
  return bot;
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
