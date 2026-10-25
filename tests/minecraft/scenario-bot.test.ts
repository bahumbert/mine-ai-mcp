import assert from "node:assert/strict";
import { setImmediate, setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { Bot } from "mineflayer";
import { plugin as toolPlugin } from "mineflayer-tool";
import { scenarioDefinitionSchema } from "mine-labs";
import { Vec3 } from "vec3";
import { createFakeBot, itemOf, listenersAddedSince } from "../../src/test-support/fake-bot/index.ts";
import { prepareScenarioBot } from "./scenario-bot.ts";

const FEET = new Vec3(0, 0, 0);

/** The scenario's player at the origin, its column `"void"` until `terrain` loads it; `added` counts listeners beyond the idle bot's. */
async function fixture(terrain: "loaded" | "absent" = "loaded", options: { readonly mainhand?: string } = {}) {
  const { bot, world, clock, server, inventory } = createFakeBot({ username: "Actor", position: FEET, food: 0, cells: terrain === "absent" ? { "0,0,0": "void" } : {} });
  // The tool plugin as the host loads it, which loads its pathfinder a tick later (`await delay(0)`): that plugin keeps a physics listener for good, so it is the idle bot's.
  bot.loadPlugin(toolPlugin);
  await delay(0);
  const added = listenersAddedSince(bot);
  const controller = new AbortController();
  const ready = Promise.withResolvers<void>();
  const arranged = Promise.withResolvers<void>();
  const session = {
    scenario: scenarioDefinitionSchema.parse({
      players: [{ name: "Actor", pos: [0, 0, 0], ...(options.mainhand && { equipment: { mainhand: options.mainhand } }) }],
      goal: { kind: "completion" },
    }),
    signal: controller.signal,
    ready: () => ready.resolve(),
    arranged: arranged.promise,
  };
  return { bot, world, clock, server, inventory, added, controller, ready, arranged, session };
}

/** Mineflayer takes the selected slot the server sends at login: the one the body's last trial left. */
async function joinedOnSlot(slot: number, terrain: "loaded" | "absent" = "loaded", options: { readonly mainhand?: string } = {}) {
  const harness = await fixture(terrain, options);
  harness.bot.setQuickBarSlot(slot);
  let reported = false;
  void harness.ready.promise.then(() => void (reported = true));
  return { ...harness, reported: () => reported };
}

/** Spawn and vitals, as the one packet of the server's join sends them. */
async function hearJoin(bot: Bot) {
  bot.emit("spawn");
  bot.emit("health");
  await setImmediate();
}

test("readiness observes vitals, accepts zero food, and ends physics control before execution", async () => {
  const { bot, world, added, session, ready, arranged } = await fixture("absent");
  const prepared = prepareScenarioBot(bot, session);
  bot.emit("spawn");
  await setImmediate();
  assert.equal(added("forcedMove"), 0, "arrangement must wait for an actual health packet");
  bot.emit("health");
  await ready.promise;
  bot.emit("forcedMove");
  arranged.resolve();
  await setImmediate();
  assert.equal(bot.physicsEnabled, false, "keep physics paused while terrain is absent");

  world.setCell(FEET, "air");
  await delay(60); // Let the 50 ms column observation see the loaded terrain.
  assert.equal(bot.physicsEnabled, true);
  for (let tick = 0; tick < 10; tick++) {
    bot.emit("physicsTick");
    await setImmediate();
  }
  await prepared;
  for (const event of ["spawn", "health", "forcedMove", "physicsTick"] as const) {
    assert.equal(added(event), 0, `${event} setup listener leaked`);
  }
  bot.emit("spawn");
  assert.equal(bot.physicsEnabled, true, "later spawns must not pause execution");
});

test("cancelling before spawn removes both startup waits and restores physics", async () => {
  const { bot, added, session, controller } = await fixture();
  const prepared = prepareScenarioBot(bot, session);
  const stopped = new Error("stop before spawn");
  controller.abort(stopped);
  await assert.rejects(prepared, (cause) => cause === stopped);
  assert.equal(bot.physicsEnabled, true);
  for (const event of ["spawn", "health", "error"] as const) assert.equal(added(event), 0);
});

test("cancellation interrupts both terrain and landing waits without another physics tick", async () => {
  for (const phase of ["terrain", "landing"]) {
    const { bot, added, session, ready, arranged, controller } = await fixture(phase === "terrain" ? "absent" : "loaded");
    bot.entity.onGround = false;
    const prepared = prepareScenarioBot(bot, session);
    bot.emit("spawn");
    bot.emit("health");
    await ready.promise;
    bot.emit("forcedMove");
    arranged.resolve();
    await setImmediate();
    assert.equal(bot.physicsEnabled, phase === "landing");
    controller.abort(new Error(`stop during ${phase}`));
    await assert.rejects(prepared);
    assert.equal(bot.physicsEnabled, true);
    assert.equal(added("physicsTick"), 0);
    assert.equal(added("forcedMove"), 0);
  }
});

test("a body that joined on slot 1 selects slot 0 and reports ready only after 40 server ticks", async () => {
  const { bot, session, clock, reported } = await joinedOnSlot(1);
  const prepared = prepareScenarioBot(bot, session);
  await hearJoin(bot);

  assert.equal(bot.quickBarSlot, 0, "the slot is selected before the player is reported ready");
  await clock.advance(1_000); // one time packet: 20 ticks
  await delay(60); // the wait looks at the age every 25 ms of wall clock
  assert.equal(reported(), false, "20 ticks do not show the server read the change: it sends no answer to it");
  await clock.advance(1_000);
  await delay(60);
  assert.equal(reported(), true);
  prepared.catch(() => undefined);
});

test("a body already on slot 0 is reported ready without waiting for a time packet", async () => {
  const { bot, session, reported } = await joinedOnSlot(0);
  const prepared = prepareScenarioBot(bot, session);
  await hearJoin(bot);
  await setImmediate();
  assert.equal(reported(), true);
  prepared.catch(() => undefined);
});

test("a slot change the server does not confirm in time fails the preparation", async () => {
  const { bot, session, server, reported } = await joinedOnSlot(1);
  server.stop(); // no time packet, so no tick is ever counted
  const prepared = prepareScenarioBot(bot, session, { slotChangeWallMs: 30 });
  prepared.catch(() => undefined);
  await hearJoin(bot);

  await assert.rejects(prepared, /slot 0 not confirmed by 40 server ticks within 0\.03 s/);
  assert.equal(reported(), false, "never ready on a wrong slot");
  assert.equal(bot.physicsEnabled, true);
});

test("cancelling while the slot change is awaited ends the preparation with the cancel", async () => {
  const { bot, session, controller, reported } = await joinedOnSlot(1);
  const prepared = prepareScenarioBot(bot, session);
  await hearJoin(bot);
  const stopped = new Error("stop during the slot wait");
  controller.abort(stopped);
  await assert.rejects(prepared, (cause) => cause === stopped);
  assert.equal(reported(), false);
  assert.equal(bot.physicsEnabled, true);
});

test("a declared main hand is expected in slot 0, where the server fills it after the change", async () => {
  const { bot, session, clock, inventory, ready, arranged, reported } = await joinedOnSlot(1, "loaded", { mainhand: "stone" });
  const prepared = prepareScenarioBot(bot, session);
  await hearJoin(bot);
  await clock.advance(1_000);
  await clock.advance(1_000);
  await ready.promise;
  arranged.resolve();
  inventory.updateSlot(36, itemOf(bot.registry, "stone")); // the server's selected slot, which the change moved to 0
  bot.emit("forcedMove");
  await setImmediate();
  for (let tick = 0; tick < 10; tick++) {
    bot.emit("physicsTick");
    await setImmediate();
  }
  await prepared;
  assert.equal(reported(), true);
  assert.equal(bot.heldItem?.name, "stone");
});
