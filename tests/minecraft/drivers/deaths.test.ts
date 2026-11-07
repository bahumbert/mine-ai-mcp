import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { Bot } from "mineflayer";
import { createFakeBot, listenerCounts } from "../../../src/test-support/fake-bot/index.ts";
import { observeDeaths } from "./deaths.ts";

/**
 * `death_combat_event`'s message as a chat component with a text node. The packet itself and its place in a death are
 * measured (scenario `player-death-runtime-event`, contract check `respawn-after-death`), and the fake's death sends it
 * with `message: undefined`; the text-node shape of a message is UNMEASURED, and the shape and the `playerId` filter
 * follow `src/runtime/player-events.ts` (`onCombatDeath`), which renders it with `deathMessage`. A contract check for a
 * message's shape is a question for the master.
 */
const DROWNED = { type: "compound", value: { text: { type: "string", value: "drowned" } } };

/** The fake bot with a death reader on it, disposed when the test ends. */
function readerOnBot(t: TestContext) {
  const harness = createFakeBot();
  const seen = observeDeaths(harness.bot);
  t.after(seen.dispose);
  return { ...harness, seen };
}

const combatDeathPacket = (bot: Bot, playerId: number) => bot._client.emit("death_combat_event", { playerId, message: DROWNED });

test("a death then the first spawn after it is one death and one respawn; a later spawn is not another", (t) => {
  const { bot, combat, seen } = readerOnBot(t);

  combat.setHealth(0, 10);
  combat.setHealth(20, 20);
  bot.emit("spawn");

  assert.equal(seen.deaths.length, 1);
  assert.equal(seen.respawns.length, 1);
  assert.ok(seen.respawns[0]!.atMs >= seen.deaths[0]!.atMs);
});

test("a spawn with no death before it (a dimension change: respawn event, then spawn) is not a respawn", (t) => {
  const { bot, seen } = readerOnBot(t);

  bot.emit("respawn");
  bot.emit("spawn");

  assert.equal(seen.deaths.length, 0);
  assert.equal(seen.respawns.length, 0);
});

test("the death names the cause the combat-death packet carried; the next death does not reuse it", (t) => {
  const { bot, combat, seen } = readerOnBot(t);

  combatDeathPacket(bot, bot.entity.id);
  combat.setHealth(0, 10);
  combat.setHealth(20, 20);
  combat.setHealth(0, 10);

  assert.deepEqual(seen.deaths.map(({ cause }) => cause), ["drowned", null]);
});

test("a combat-death packet about another player is not this bot's cause", (t) => {
  const { bot, combat, seen } = readerOnBot(t);

  combatDeathPacket(bot, bot.entity.id + 1);
  combat.setHealth(0, 10);

  assert.deepEqual(seen.deaths.map(({ cause }) => cause), [null]);
});

test("dispose removes every listener it added and stops recording", () => {
  const { bot, combat } = createFakeBot();
  const before = { bot: listenerCounts(bot), client: listenerCounts(bot._client) };
  const seen = observeDeaths(bot);

  seen.dispose();
  seen.dispose();
  combat.setHealth(0, 10);
  combat.setHealth(20, 20);

  assert.deepEqual(listenerCounts(bot), before.bot);
  assert.deepEqual(listenerCounts(bot._client), before.client);
  assert.equal(seen.deaths.length, 0);
  assert.equal(seen.respawns.length, 0);
});
