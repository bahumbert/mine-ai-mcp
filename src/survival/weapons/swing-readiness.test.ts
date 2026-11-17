// One bot's swing recovery follows the server's pace across attacks and item changes.
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createMinecraftRuntime } from "../../runtime/minecraft-runtime.js";
import { createFakeBot, createFakeClock, listenersAddedSince } from "../../test-support/fake-bot/index.js";
import { serverTickPace } from "../../world/server-tick-pace.js";
import { attackAndRestart, swingReadiness } from "./swing-readiness.js";

for (const rate of [20, 10]) test(`swing readiness follows attacks and held item types at ${rate} tps`, async () => {
  const { bot, clock, server } = createFakeBot({
    clock: createFakeClock({ mode: "mocked" }), server: { ticksPerSecond: rate },
    slots: { 36: { name: "iron_sword" }, 37: { name: "iron_sword" }, 38: { name: "iron_axe" } },
    entities: { 7: { name: "zombie", position: new Vec3(0.5, 64, 2.5) } },
  });
  using _timers = clock.install();
  using _pace = serverTickPace(bot);
  const added = listenersAddedSince(bot);
  const readiness = swingReadiness(bot);
  assert.equal(swingReadiness(bot), readiness);
  assert.equal(readiness.ready(13), true, "never restarted");
  await clock.advance(4_000);
  const started = server.gameTime;
  readiness.restart();
  assert.equal(readiness.clientTicksUntilReady(13), rate === 20 ? 13 : 26);
  await clock.advance(600);
  assert.equal(readiness.ready(13), false);
  await clock.advance(50);
  assert.equal(readiness.ready(13), rate === 20);
  if (rate === 10) await clock.advance(650);
  assert.equal(clock.now(), 4_000 + 13_000 / rate);
  assert.equal(server.gameTime - started, 13);
  assert.equal(readiness.ready(13), true);
  attackAndRestart(bot, bot.entities[7]!);
  assert.equal(readiness.ready(13), false);
  assert.deepEqual(server.packets.filter(({ name }) => name === "use_entity").map(({ data }) => data), [
    { target: 7, mouse: 1, sneaking: false, location: new Vec3(0, 0, 0) },
  ]);
  await clock.advance(13_000 / rate);
  await bot.equip(bot.inventory.slots[37]!, "hand");
  assert.equal(readiness.ready(13), true);
  await bot.equip(bot.inventory.slots[38]!, "hand");
  assert.equal(readiness.ready(25), false);
  const equippedAt = server.gameTime;
  await clock.advance(24_000 / rate);
  assert.equal(readiness.ready(25), false);
  await clock.advance(1_000 / rate);
  assert.equal(server.gameTime - equippedAt, 25);
  assert.equal(readiness.ready(25), true);
  readiness[Symbol.dispose]();
  readiness[Symbol.dispose]();
  assert.equal(added("physicsTick"), 0);
  assert.equal(added("heldItemChanged"), 0);
  await clock.advance(10_000);
  assert.equal(clock.pendingGlobalTimers(), 0);
});

for (const fail of [false, true]) test(`runtime ${fail ? "cleans up a failed swing installation" : "installs swing readiness before the first equip and disposes its listeners"}`, async () => {
  const { bot, clock } = createFakeBot({
    clock: createFakeClock({ mode: "mocked" }), slots: { 9: { name: "iron_sword" } },
  });
  bot.setMaxListeners(40);
  using _timers = clock.install();
  const added = listenersAddedSince(bot);
  const options = {
    botData: { storage: { kind: "temporary" as const }, identity: { worldId: "swing", scope: { kind: "bot" as const, botId: bot.username } } },
  };
  if (fail) {
    const on = bot.on.bind(bot);
    bot.on = (event, listener) => {
      if (event === "physicsTick") throw new Error("Swing listener refused");
      return on(event, listener);
    };
    await assert.rejects(createMinecraftRuntime(bot, options), /Swing listener refused/);
    bot.on = on;
    assert.equal(added("heldItemChanged"), 0);
    assert.equal(added("time"), 0);
    return;
  }
  const runtime = await createMinecraftRuntime(bot, options);
  try {
    await bot.equip(bot.inventory.items()[0]!, "hand");
    assert.equal(swingReadiness(bot).ready(13), false);
  } finally { await runtime.close(); }
  assert.equal(added("heldItemChanged"), 0);
  assert.equal(added("physicsTick"), 0);
});
