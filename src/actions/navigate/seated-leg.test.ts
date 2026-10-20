import assert from "node:assert/strict";
import test from "node:test";
import { mountedBot, openSeaBot } from "../../test-support/boat-bot.js";
import { seatedLegPlan } from "./seated-leg.js";

test("a bot that sits in no boat has no seated leg", () => {
  assert.equal(seatedLegPlan(openSeaBot().bot, { x: 0.5, z: 60 }).kind, "not_seated");
});

test("a navigate started seated with deep water on the way rides on", async () => {
  const { bot } = await mountedBot();
  assert.equal(seatedLegPlan(bot, { x: 0.5, z: 60 }).kind, "ride_on");
});

test("a navigate started seated with no deep water on the way (shallows) gets off first", async () => {
  const { bot } = await mountedBot({ waterDepth: 2 });
  assert.equal(seatedLegPlan(bot, { x: 0.5, z: 60 }).kind, "get_off");
});
