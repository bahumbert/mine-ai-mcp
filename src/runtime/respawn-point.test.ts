// Respawn knowledge observed through the player event listeners.
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { recordPersonalRespawn } from "../actions/portal-entry/respawn-knowledge.js";
import { temporaryBotData } from "../test-support/bot-data.js";
import { createFakeBot, createFakeClock } from "../test-support/fake-bot/index.js";
import { observePlayerEvents } from "./player-events.js";
import { respawnPoint } from "./respawn-point.js";

test("a death and its respawn record where she woke, with bed precedence and reset", async (t) => {
  const clock = createFakeClock({ mode: "mocked" });
  using _installed = clock.install();
  const { bot, server, combat } = createFakeBot({ clock });
  const data = temporaryBotData({ botId: bot.username, closeAfter: t });
  t.after(observePlayerEvents(bot, data, () => undefined));
  server.setRespawnPoint(new Vec3(40.5, 64, 40.5));
  combat.setHealth(0, 20);
  await clock.advance(2_000);
  assert.deepEqual(respawnPoint(bot), { kind: "last_wake", dimension: "overworld", x: 40.5, y: 64, z: 40.5, distance: 0 });
  recordPersonalRespawn(bot, { x: 50.5, y: 64, z: 40.5 });
  combat.setHealth(0, 20);
  await clock.advance(2_000);
  assert.equal(respawnPoint(bot)?.kind, "bed");
  bot.emit("spawnReset");
  combat.setHealth(0, 20);
  await clock.advance(2_000);
  assert.equal(respawnPoint(bot)?.kind, "last_wake");
});

test("login and dimension changes without death do not record a wake", (t) => {
  const { bot } = createFakeBot();
  const data = temporaryBotData({ botId: bot.username, closeAfter: t });
  t.after(observePlayerEvents(bot, data, () => undefined));
  bot.emit("spawn");
  assert.equal(respawnPoint(bot), null);
  bot.spawnPoint = new Vec3(0, 70, 0);
  bot.emit("spawn");
  assert.equal(respawnPoint(bot)?.kind, "world_spawn");
  bot.game.dimension = "the_nether";
  bot.emit("respawn");
  bot.emit("spawn");
  assert.equal(respawnPoint(bot)?.kind, "world_spawn");
});
