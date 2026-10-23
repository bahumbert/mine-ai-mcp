import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { type FakeWorld, createFakeBot, itemOf } from "../../test-support/fake-bot/index.js";
import { endermanGazeRisk } from "../perception/combat/gaze.js";
import { attachEndermanGazeControl } from "./enderman-gaze.js";

const ENDERMAN_FEET = new Vec3(0.5, 63.07, -10);

/** The bot in open End air, facing an Enderman ten blocks north. */
function fixture() {
  return createFakeBot({ dimension: "the_end", groundY: null, entities: { 7: { name: "enderman", position: ENDERMAN_FEET } } });
}

/** Stone across the line between the bot's eyes and the Enderman's head (or air again). */
function screen(world: FakeWorld, block: "stone" | "air"): void {
  for (const x of [-1, 0, 1]) for (const y of [64, 65, 66]) world.setCell(new Vec3(x, y, -5), block);
}

test("End eye contact is diverted without changing movement yaw; idle gaze is guarded too", async () => {
  const { bot } = fixture();
  const original = bot.look;
  const guard = attachEndermanGazeControl(bot, () => null);
  await bot.look(0, 0, true);
  assert.equal(bot.entity.yaw, 0);
  assert.equal(bot.entity.pitch, -Math.PI / 2);
  bot.entity.pitch = 0;
  bot.emit("physicsTick");
  assert.equal(bot.entity.pitch, -Math.PI / 2);
  await bot.look(0, 0.7, true);
  assert.equal(bot.entity.pitch, 0.7, "safe upward crystal aim stays intact");
  guard[Symbol.dispose]();
  assert.equal(bot.look, original);
  assert.equal(bot.listenerCount("physicsTick"), 0);
});

test("gaze guard respects dimension, cover, pumpkin and deliberate selected Enderman combat", async () => {
  const { bot, world } = fixture();
  const risk = () => endermanGazeRisk(bot, bot.entity.position, 0, 0);
  assert.equal(risk(), true);
  bot.game.dimension = "overworld";
  assert.equal(risk(), false);
  bot.game.dimension = "the_end";
  bot.inventory.slots[5] = itemOf(bot.registry, "carved_pumpkin");
  assert.equal(risk(), false);
  bot.inventory.slots[5] = null;
  screen(world, "stone");
  assert.equal(risk(), false);
  screen(world, "air");
  using _guard = attachEndermanGazeControl(bot, () => ({ kind: "mob", targetId: 7 }));
  await bot.look(0, 0, true);
  assert.equal(bot.entity.pitch, 0);
  bot.entities[8] = createFakeBot({ entities: { 8: { name: "enderman", position: ENDERMAN_FEET } } }).bot.entities[8]!;
  await bot.look(0, 0, true);
  assert.equal(bot.entity.pitch, -Math.PI / 2, "another Enderman is still protected from provocation");
});
