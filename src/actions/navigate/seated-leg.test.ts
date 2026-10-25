import assert from "node:assert/strict";
import test from "node:test";
import { createFakeBot, type FakeCell } from "../../test-support/fake-bot/index.js";
import { seatedLegPlan } from "./seated-leg.js";

/** Water from the sea floor to y 62 in the lane x -8 to 8, z -8 to 70 that a way to z 60 crosses; stone under the floor. */
function seaCells(depth: number): Record<string, FakeCell> {
  const cells: Record<string, FakeCell> = {};
  for (let x = -8; x <= 8; x++) for (let y = 63 - depth; y <= 62; y++) for (let z = -8; z <= 70; z++) cells[`${x},${y},${z}`] = "water";
  return cells;
}

/** A bot at the edge of an open sea `depth` deep (13 by default), beside boat 7; seated in it by the server when `seated`. */
async function seaBot({ depth = 13, seated = false } = {}) {
  const harness = createFakeBot({
    position: { x: 0.5, y: 63, z: 0.5 },
    groundY: 62 - depth,
    cells: seaCells(depth),
    entities: { 7: { name: "oak_boat", position: { x: 0.5, y: 62.5, z: 3.5 } } },
  });
  if (seated) {
    harness.bot.mount(harness.bot.entities[7]!);
    await harness.clock.advance(50);
  }
  return harness;
}

test("a bot that sits in no boat has no seated leg", async () => {
  assert.equal(seatedLegPlan((await seaBot()).bot, { x: 0.5, z: 60 }).kind, "not_seated");
});

test("a navigate started seated with deep water on the way rides on", async () => {
  const { bot } = await seaBot({ seated: true });
  assert.equal(seatedLegPlan(bot, { x: 0.5, z: 60 }).kind, "ride_on");
});

test("a navigate started seated with no deep water on the way (shallows) gets off first", async () => {
  const { bot } = await seaBot({ depth: 2, seated: true });
  assert.equal(seatedLegPlan(bot, { x: 0.5, z: 60 }).kind, "get_off");
});
