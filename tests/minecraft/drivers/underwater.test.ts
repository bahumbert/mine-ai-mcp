// The underwater driver's air recovery follows the server clock and cleans up on every exit.
import assert from "node:assert/strict";
import test from "node:test";
import { getEventListeners } from "node:events";
import { mkdtempDisposable } from "node:fs/promises";
import { scenarioDefinitionSchema } from "mine-labs";
import { Vec3 } from "vec3";
import { createMinecraftRuntime } from "../../../src/runtime/minecraft-runtime.ts";
import { startFreezeWatch } from "../../../src/diagnostics/freeze-watch.ts";
import { createFakeBot, createFakeClock, listenersAddedSince } from "../../../src/test-support/fake-bot/index.ts";
import { watch } from "../../../src/test-support/pending.ts";
import { airSupplyTicks } from "../../../src/world/air-supply.ts";
import { run, waitForFullAir } from "../../../scenarios/flat/water/underwater.ts";
import { openRuntime, openRuntimeWith } from "../../../scenarios/src/runtime.ts";
import type { MineAiScenarioContext } from "../../../scenarios/src/scenario-client.ts";
import { DRIVER_CLOCK_STOPPED_MS } from "./server-ticks.ts";

/** Air and world-age answers mirror the air-supply-under-water and world-age-at-slow-tick contracts. */
function fixture(rate: number) {
  const clock = createFakeClock({ mode: "mocked" });
  const h = createFakeBot({ clock, position: { x: 0, y: 64, z: 0 }, cells: { "0,64,0": "water", "0,65,0": "water" }, server: { startAge: 1000, ticksPerSecond: rate } });
  const controller = new AbortController();
  const added = listenersAddedSince(h.bot);
  h.breath.setAirSupply(300);
  return { ...h, controller, added, async clean() {
    for (const event of h.bot.eventNames()) assert.equal(added(String(event)), 0, String(event));
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    assert.equal(clock.pendingGlobalTimers(), 0);
    await clock.advance(31_000);
    assert.equal(clock.pendingGlobalTimers(), 0);
  } };
}

for (const rate of [20, 10]) {
  test(`air recovery stays pending through +240 and accepts the refill at ${rate} tps`, async () => {
    const h = fixture(rate); using _timers = h.clock.install();
    const pending = waitForFullAir(h.bot, 240, h.controller.signal); const state = watch(pending);
    await h.clock.advance(240_000 / rate);
    assert.equal(h.bot.time.age, 1240); assert.equal(state.over, false, "must not spend server budget on client ticks");
    h.breath.setAirSupply(296); h.world.setCell(new Vec3(0, 65, 0), "air");
    await h.clock.advance(25, 25); assert.equal(airSupplyTicks(h.bot), 296); assert.equal(state.over, false);
    await h.clock.advance(1000 / rate - 25, 25);
    assert.equal(h.breath.airSupply, 300);
    assert.equal(await h.clock.settle(pending, 50), "settled");
    assert.equal(h.bot.time.age, 1240); await h.clean();
  });

  for (const ticks of [240, 400]) test(`wet head exhausts ${ticks} server ticks plus packet margin at ${rate} tps`, async () => {
    const h = fixture(rate); using _timers = h.clock.install();
    const pending = waitForFullAir(h.bot, ticks, h.controller.signal); const state = watch(pending);
    await h.clock.advance(ticks * 1000 / rate);
    assert.equal(h.bot.time.age, 1000 + ticks); assert.equal(state.over, false, "packet margin remains");
    await h.clock.advance(20_000 / rate);
    assert.equal(h.bot.time.age, 1020 + ticks);
    assert.equal(await h.clock.settle(pending, 50), "budget-exhausted"); await h.clean();
  });
}

test("a full meter with wet eyes waits until the eyes are dry", async () => {
  const h = fixture(20); using _timers = h.clock.install();
  const pending = waitForFullAir(h.bot, 240, h.controller.signal); const state = watch(pending);
  await h.clock.advance(0); assert.equal(state.over, false);
  h.world.setCell(new Vec3(0, 65, 0), "air");
  assert.equal(await h.clock.settle(pending, 50), "settled"); await h.clean();
});

test("a dry head with unknown air settles without a clock tick or leftover work", async () => {
  const h = fixture(20); using _timers = h.clock.install();
  const index = h.bot.registry.entitiesByName.player!.metadataKeys!.indexOf("air_supply");
  h.world.setCell(new Vec3(0, 65, 0), "air"); delete h.bot.entity.metadata[index];
  const pending = waitForFullAir(h.bot, 240, h.controller.signal); const state = watch(pending);
  await h.clock.advance(0); assert.equal(state.over, true); assert.equal(await pending, "settled"); await h.clean();
});

test("stopped server stalls from its last packet while client physics continues", async () => {
  const h = fixture(10); using _timers = h.clock.install();
  let physics = 0; const onTick = () => { physics++; }; h.bot.on("physicsTick", onTick);
  const pending = waitForFullAir(h.bot, 240, h.controller.signal); const state = watch(pending);
  await h.clock.advance(2050); assert.equal(h.bot.time.age, 1020); h.server.stop();
  await h.clock.advance(DRIVER_CLOCK_STOPPED_MS - 75, 25); assert.equal(state.over, false);
  await h.clock.advance(25, 25); assert.equal(state.over, true); assert.equal(await pending, "stalled");
  assert.equal(h.bot.time.age, 1020); assert.ok(physics > 240); h.bot.off("physicsTick", onTick); await h.clean();
});

test("abort releases a wet recovery wait immediately with the same reason", async () => {
  const h = fixture(10); using _timers = h.clock.install();
  const pending = waitForFullAir(h.bot, 240, h.controller.signal); const state = watch(pending);
  const reason = new Error("trial cancelled");
  await h.clock.advance(2050); h.controller.abort(reason); await h.clock.advance(0);
  assert.equal(state.over, true, "abort must settle before the next tick");
  await assert.rejects(pending, error => error === reason); await h.clean();
});

for (const end of ["abort", "stalled"] as const) test(`driver ${end} retains recovery detail and cleans up the runtime`, async () => {
  await using scratch = await mkdtempDisposable("/dev/shm/underwater-driver-");
  const h = fixture(10); using _timers = h.clock.install();
  // The real runtime installs more than ten independent observers; their removal is checked below.
  h.bot.setMaxListeners(30);
  h.breath.hold(300);
  const context: MineAiScenarioContext = { bot: h.bot, signal: h.controller.signal, log() {}, progress() {},
    scenario: scenarioDefinitionSchema.parse({ params: { legs: [], backstop: end === "stalled" }, goal: { kind: "completion" } }),
    get navigation(): never { throw new Error("no navigation telemetry"); }, get pathfinder(): never { throw new Error("no pathfinder telemetry"); } };
  let closes = 0, unsubscribes = 0, attached = false;
  const opener: typeof openRuntime = async (...args) => {
    const runtime = await openRuntimeWith({ createRuntime: createMinecraftRuntime, startWatch: startFreezeWatch }, args[0].bot, args[1], { incidents: { directory: scratch.path } }, undefined);
    const close = runtime.close.bind(runtime); const subscribe = runtime.navigation.onEvent.bind(runtime.navigation);
    runtime.close = async () => { closes++; await close(); };
    runtime.navigation.onEvent = callback => { const unsubscribe = subscribe(callback); attached = true; return () => { unsubscribes++; unsubscribe(); }; };
    return runtime;
  };
  const pending = run(context, opener); const state = watch(pending);
  await h.clock.settle((async () => { while (!attached) await h.clock.sleep(50); })(), 5000);
  await h.clock.advance(2050); assert.equal(state.over, false);
  if (end === "abort") {
    const reason = new Error("trial abort"); h.controller.abort(reason); await h.clock.advance(0);
    assert.equal(closes, 1, "abort reaches cleanup before another tick"); assert.equal(unsubscribes, 1);
    const rejected = assert.rejects(pending, error => error === reason); await h.clock.settle(rejected, 50);
  } else {
    h.server.stop(); const result = await h.clock.settle(pending, DRIVER_CLOCK_STOPPED_MS + 10_000);
    assert.equal(result.status, "failed"); assert.match(result.detail ?? "", /airRecovery.*stalled/); assert.match(result.detail ?? "", /Backstop takeover/);
  }
  assert.equal(closes, 1); assert.equal(unsubscribes, 1); await h.clean();
});
