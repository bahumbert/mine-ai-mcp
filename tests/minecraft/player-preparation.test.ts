import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import type { ScenarioDefinition } from "mine-labs/client";
import { Vec3 } from "vec3";

import { createFakeBot, itemOf, listenerCounts } from "../../src/test-support/fake-bot/index.ts";
import { observeScenarioPlayerPreparation } from "./player-preparation.ts";

/** The scenario's player on the shared fake: standing on the superflat floor at y -59. */
function scenarioBot(username = "CraftBot", carried: Readonly<Record<string, number>> = {}) {
  return createFakeBot({ username, position: { x: 0, y: -59, z: 0 }, carried });
}

test("player readiness waits for the declared equipment to reach its actual slot", async () => {
  const { bot, inventory } = scenarioBot();
  const idle = listenerCounts(inventory);
  const scenario = { world: { dimension: "overworld" },
    players: [{ name: "CraftBot", inventory: [], equipment: { head: "golden_helmet" } }],
  } as unknown as ScenarioDefinition;
  const observation = observeScenarioPlayerPreparation(bot, scenario);
  let ready = false;
  const prepared = observation.wait().then(() => { ready = true; });
  inventory.updateSlot(6, itemOf(bot.registry, "golden_helmet")); // The right item in the wrong slot is not ready.
  await setImmediate();
  assert.equal(ready, false);
  inventory.updateSlot(5, itemOf(bot.registry, "golden_helmet"));
  await prepared;
  observation.close();
  assert.deepEqual(listenerCounts(inventory), idle);
});

test("requires a post-ready inventory update even when stale local counts already match", async () => {
  const { bot, inventory } = scenarioBot("CraftBot", { oak_log: 4 });
  const idle = { bot: listenerCounts(bot), inventory: listenerCounts(inventory) };
  const scenario = {
    world: { dimension: "overworld" },
    players: [{ name: "CraftBot", inventory: [{ item: "oak_log", count: 4 }] }],
  } as ScenarioDefinition;
  const observation = observeScenarioPlayerPreparation(bot, scenario);
  let settled = false;
  const prepared = observation.wait().then(() => {
    settled = true;
  });

  await setImmediate();
  assert.equal(settled, false);

  // The server's redraw of the slot the logs already fill.
  inventory.updateSlot(36, itemOf(bot.registry, "oak_log", 4));
  await prepared;

  assert.equal(inventory.listenerCount("updateSlot"), (idle.inventory.updateSlot ?? 0) + 1);
  observation.close();
  assert.deepEqual({ bot: listenerCounts(bot), inventory: listenerCounts(inventory) }, idle);
});

test("a Nether start settles only once the client is in the Nether, at its position, at its declared health", async () => {
  const { bot } = scenarioBot("Fighter");
  const idle = listenerCounts(bot);
  const scenario = {
    world: { dimension: "the_nether" },
    players: [{ name: "Fighter", pos: [-27.5, 82, 355.5], health: 11, inventory: [] }],
  } as unknown as ScenarioDefinition;
  const observation = observeScenarioPlayerPreparation(bot, scenario);
  let settled = false;
  const prepared = observation.wait().then(() => {
    settled = true;
  });

  // Still in the overworld: a matching position there is the wrong place.
  bot.entity.position = new Vec3(-27.5, 82, 355.5);
  bot.emit("move", bot.entity.position);
  await setImmediate();
  assert.equal(settled, false);

  // Respawned into the Nether, but the wound has not landed yet.
  bot.game.dimension = "the_nether";
  bot.emit("spawn");
  await setImmediate();
  assert.equal(settled, false);

  bot.health = 11;
  bot.emit("health");
  await prepared;
  observation.close();
  assert.deepEqual(listenerCounts(bot), idle);
});
