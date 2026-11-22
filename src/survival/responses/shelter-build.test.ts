// Shelter contact preserves shield staging and shares the connected bot's swing recovery.
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { combatTestContext, onAttack } from "../../test-support/combat.js";
import { createFakeBot, createFakeClock, listenersAddedSince } from "../../test-support/fake-bot/index.js";
import { serverTickPace } from "../../world/server-tick-pace.js";
import { CombatItemUse } from "../weapons/item-use.js";
import { swingReadiness } from "../weapons/swing-readiness.js";
import { holdShelterGuard, repelShelterIntruder, type ShelterBuild } from "./shelter-build.js";

/** Start with a pickaxe: contact must equip its sword, then hold shield and swing recovery sequentially. */
function shelter(rate: number) {
  const harness = createFakeBot({
    clock: createFakeClock({ mode: "mocked" }), server: { ticksPerSecond: rate },
    slots: { 36: { name: "iron_pickaxe" }, 37: { name: "iron_sword" }, 45: { name: "shield" } },
    entities: { 7: { name: "zombie", position: new Vec3(0.5, 64, 1.5) } },
  });
  const { bot } = harness;
  const stop = new AbortController();
  const build: ShelterBuild = {
    bot, options: { signal: stop.signal, threatContext: combatTestContext(bot), recoverTo: 18, maximumMs: 1 },
    itemUse: new CombatItemUse(bot, (ticks, wallEnd) => holdShelterGuard(build, ticks, undefined, wallEnd)),
    enclosed: false, constructionDeadline: 1, dug: 0, walled: 0, capped: false, ate: null, swings: 0,
    recovery: null, refusal: null, pass: 0, blockedCells: new Map(),
  };
  return { ...harness, build, stop, target: bot.entities[7]! };
}

for (const rate of [20, 10]) test(`shelter's first changed-weapon swing waits 5 + 13 server ticks at ${rate} tps`, async () => {
  const { bot, clock, server, build, target } = shelter(rate);
  using _timers = clock.install();
  using _pace = serverTickPace(bot);
  using _readiness = swingReadiness(bot);
  await clock.advance(4_000);
  const changed = { ms: 0, tick: 0 };
  bot.on("heldItemChanged", () => {
    if (bot.heldItem?.name === "iron_sword") Object.assign(changed, { ms: clock.now(), tick: server.gameTime });
  });
  const hits: { ms: number; tick: number }[] = [];
  onAttack(server, () => hits.push({ ms: clock.now() - changed.ms, tick: server.gameTime - changed.tick }));
  await clock.settle(repelShelterIntruder(build, target), 10_000);
  assert.deepEqual(hits, [{ ms: rate === 20 ? 900 : 1_800, tick: 18 }]);
  assert.equal(build.swings, 1);
  const healthKey = bot.registry.entitiesByName.zombie!.metadataKeys!.indexOf("health");
  assert.equal(target.metadata[healthKey], 14, "the first hit is full strength");
  assert.equal(server.gameTime - changed.tick, 31, `finished at ${clock.now()} ms`);
});

for (const rate of [20, 10]) test(`shelter retains another owner's recovery with the same weapon at ${rate} tps`, async () => {
  const { bot, clock, server, build, target } = shelter(rate);
  using _timers = clock.install();
  using _pace = serverTickPace(bot);
  using readiness = swingReadiness(bot);
  await clock.advance(4_000);
  await bot.equip(bot.inventory.slots[37]!, "hand");
  readiness.restart();
  const started = server.gameTime;
  const pending = repelShelterIntruder(build, target);
  await clock.advance(12_000 / rate);
  assert.equal(build.swings, 0, `still recovering at ${clock.now()} ms, world tick ${server.gameTime}`);
  await clock.advance(1_000 / rate);
  assert.equal(build.swings, 1);
  assert.equal(server.gameTime - started, 13);
  await clock.settle(pending, 5_000);
});

for (const rate of [20, 10]) test(`a replacement shelter intruder completes an interrupted shield startup at ${rate} tps`, async () => {
  const { bot, clock, server, combat, entities, build, target } = shelter(rate);
  using _timers = clock.install();
  using _pace = serverTickPace(bot);
  using _readiness = swingReadiness(bot);
  await bot.equip(bot.inventory.slots[37]!, "hand");
  await clock.advance(4_000);
  const started = { ms: clock.now(), tick: server.gameTime };
  const hits: number[] = [];
  onAttack(server, () => hits.push(server.gameTime - started.tick));
  const added = listenersAddedSince(bot);
  const first = repelShelterIntruder(build, target);
  await clock.advance(100);
  combat.kill(target.id);
  (build.options.threatContext.resolvedIds as Set<number>).add(target.id);
  const replacement = entities.spawn({ name: "zombie", position: new Vec3(0.5, 64, 1.5) });
  await clock.settle(first, 1_000, 10);
  await clock.settle(repelShelterIntruder(build, replacement), 10_000, 10);
  assert.equal(hits.length, 1);
  assert.ok(hits[0]! >= 5, `replacement hit after ${hits[0]} server ticks at ${clock.now() - started.ms} ms`);
  assert.equal(build.itemUse.shieldRaised, true);
  await clock.advance(10_000);
  assert.equal(hits.length, 1, "neither old hold can swing after returning");
  assert.equal(added("physicsTick"), 0);
  assert.equal(added("entityDead"), 0);
  assert.equal(clock.pendingGlobalTimers(), 0);
});

for (const exit of ["abort", "death", "target death", "stopped", "physics stopped"] as const) test(`shelter recovery releases on ${exit}`, async () => {
  const { bot, clock, server, combat, build, stop, target } = shelter(10);
  using _timers = clock.install();
  using _pace = serverTickPace(bot);
  using _readiness = swingReadiness(bot);
  // Unknown pace cannot credit a stopped server; client physics continues except in its own exit case.
  if (exit === "stopped" || exit === "physics stopped") server.stop();
  if (exit === "physics stopped") bot.physicsEnabled = false;
  else await clock.advance(4_000);
  const added = listenersAddedSince(bot);
  const started = clock.now();
  const age = bot.time.age;
  const pending = repelShelterIntruder(build, target);
  if (exit === "abort") {
    const rejected = assert.rejects(pending, /shelter cancelled/);
    await clock.advance(100);
    stop.abort(new Error("shelter cancelled"));
    await rejected;
  } else {
    await clock.advance(100);
    if (exit === "death") bot.health = 0;
    if (exit === "target death") {
      combat.kill(target.id);
      // The hostile observer files the death in this shared record before the next turn.
      (build.options.threatContext.resolvedIds as Set<number>).add(target.id);
    }
    await clock.settle(pending, 10_000, 10);
    assert.ok(clock.now() - started <= (exit.includes("stopped") ? 8_700 : 200));
  }
  assert.equal(build.swings, 0);
  if (exit.includes("stopped")) assert.equal(bot.time.age, age);
  await clock.advance(10_000);
  assert.equal(added("physicsTick"), 0);
  assert.equal(added("entityDead"), 0);
  assert.equal(clock.pendingGlobalTimers(), 0);
});
