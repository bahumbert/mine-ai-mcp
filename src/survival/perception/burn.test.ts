import assert from "node:assert/strict";
import test from "node:test";
import { createFakeBot } from "../../test-support/fake-bot/index.js";
import { burnLeft, recordFireContact } from "./burn.js";

test("the burn estimate follows the latest contact, caps clock jumps, and clears on death", async () => {
  const { bot, clock, server } = createFakeBot({ server: { startAge: 1000 } });
  assert.deepEqual(burnLeft(bot), { ticks: 0, hp: 0 });
  recordFireContact(bot, "lava", 1000);
  await clock.advance(5_000);
  assert.deepEqual(burnLeft(bot), { ticks: 200, hp: 10 });
  await clock.advance(500);
  server.resendTime();
  assert.deepEqual(burnLeft(bot), { ticks: 190, hp: 10 });
  recordFireContact(bot, "fire", 1105);
  assert.deepEqual(burnLeft(bot), { ticks: 295, hp: 15 });
  recordFireContact(bot, "lava", 2000);
  assert.deepEqual(burnLeft(bot), { ticks: 300, hp: 15 });
  bot.emit("death");
  assert.deepEqual(burnLeft(bot), { ticks: 0, hp: 0 });
});
