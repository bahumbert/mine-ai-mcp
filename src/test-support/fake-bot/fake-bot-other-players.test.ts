import assert from "node:assert/strict";
import test from "node:test";
import { type FakeBot, createFakeBot } from "./fake-bot.js";
import { PLAYER_TRACKING_BLOCKS } from "./fake-bot-other-players.js";

const SLICE_MS = 50;

/** The entity the bot files under the watched player (read through a function: an assertion on null narrows a property for good). */
const entityOf = (bot: FakeBot) => bot.players.Watched?.entity ?? null;

/** A bot at the origin and a survival player two blocks off (a join is tracked at once). */
function withPlayer() {
  const harness = createFakeBot();
  const player = harness.otherPlayers.join("Watched", harness.bot.entity.position.offset(2, 0, 0));
  return { harness, player, east: (blocks: number) => harness.bot.entity.position.offset(blocks, 0, 0) };
}

test("a joined player is listed with a position while within the tracking range, and listed without one beyond it", async () => {
  const { harness, player, east } = withPlayer();
  const { bot, clock } = harness;
  assert.ok(entityOf(bot)?.position);
  player.moveTo(east(PLAYER_TRACKING_BLOCKS + 1));
  await clock.advance(SLICE_MS);
  assert.ok(bot.players.Watched, "the tab list entry stays");
  assert.equal(entityOf(bot), null);
  assert.equal(Object.values(bot.entities).some((entity) => entity.username === "Watched"), false);
  player.moveTo(east(PLAYER_TRACKING_BLOCKS));
  await clock.advance(SLICE_MS);
  assert.deepEqual(entityOf(bot)?.position, east(PLAYER_TRACKING_BLOCKS));
});

test("a player who turns spectator loses the entity and shows game mode 3 on the tab list, and has the entity again back in survival", async () => {
  const { harness, player, east } = withPlayer();
  const { bot, clock } = harness;
  player.setGameMode("spectator");
  await clock.advance(SLICE_MS);
  assert.equal(entityOf(bot), null);
  assert.equal(bot.players.Watched!.gamemode, 3);
  player.setGameMode("survival");
  await clock.advance(SLICE_MS);
  assert.deepEqual(entityOf(bot)?.position, east(2));
  assert.equal(bot.players.Watched!.gamemode, 0);
});

test("a player who leaves is gone from the tab list and the entities", async () => {
  const { harness, player } = withPlayer();
  const { bot, clock } = harness;
  player.leave();
  await clock.advance(SLICE_MS);
  assert.equal(bot.players.Watched, undefined);
  assert.equal(Object.values(bot.entities).some((entity) => entity.username === "Watched"), false);
});
