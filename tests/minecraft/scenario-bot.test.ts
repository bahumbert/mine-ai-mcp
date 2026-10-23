import assert from "node:assert/strict";
import { setImmediate, setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { plugin as toolPlugin } from "mineflayer-tool";
import { scenarioDefinitionSchema } from "mine-labs";
import { Vec3 } from "vec3";
import { createFakeBot } from "../../src/test-support/fake-bot/index.ts";
import { prepareScenarioBot } from "./scenario-bot.ts";

const FEET = new Vec3(0, 0, 0);

/** An emitter as a listener count reads it: Node's, or Mineflayer's typed one. */
type Listened = { eventNames(): Array<string | symbol>; listenerCount(event: string | symbol): number };

/** The scenario's player at the origin, its column `"void"` until `terrain` loads it; `added` counts listeners beyond the idle bot's. */
async function fixture(terrain: "loaded" | "absent" = "loaded") {
  const { bot, world } = createFakeBot({ username: "Actor", position: FEET, food: 0, cells: terrain === "absent" ? { "0,0,0": "void" } : {} });
  // The tool plugin as the host loads it, which loads its pathfinder a tick later (`await delay(0)`): that plugin keeps a physics listener for good, so it is the idle bot's.
  bot.loadPlugin(toolPlugin);
  await delay(0);
  const listened: Listened = bot;
  const idle = new Map(listened.eventNames().map((event) => [event, listened.listenerCount(event)]));
  const added = (event: string) => listened.listenerCount(event) - (idle.get(event) ?? 0);
  const controller = new AbortController();
  const ready = Promise.withResolvers<void>();
  const arranged = Promise.withResolvers<void>();
  const session = {
    scenario: scenarioDefinitionSchema.parse({
      players: [{ name: "Actor", pos: [0, 0, 0] }],
      goal: { kind: "completion" },
    }),
    signal: controller.signal,
    ready: () => ready.resolve(),
    arranged: arranged.promise,
  };
  return { bot, world, added, controller, ready, arranged, session };
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
