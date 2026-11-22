import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { spyOn } from "bun:test";
import { Vec3 } from "vec3";
import { run as closedCover } from "./closed-cover.ts";
import { run as hurtInWater } from "./hurt-bot-in-water.ts";
import { awaitEncounters, hurt, readReflexOutcomes } from "./reflex.ts";
import * as scenarioRuntime from "../../src/runtime.ts";
import type { MineAiScenarioContext } from "../../src/scenario-client.ts";
import { DEFAULT_SURVIVAL_POLICY } from "../../../src/survival/policy/contract.js";
import type { SurvivalReceipt } from "../../../src/survival/evidence/contract.js";
import { createFakeBot, createFakeClock, listenersAddedSince } from "../../../src/test-support/fake-bot/index.ts";

test("a failed event read reports the runtime error instead of a schema error", async () => {
  const runtime = {
    actions: [{ name: "read_recent_events" }],
    run: async () => ({ action: "read_recent_events", durationMs: 1,
      result: { kind: "runtime_failure", status: "failed", error: "[MINECRAFT_DISCONNECTED] socket closed" } }),
  } as unknown as scenarioRuntime.Runtime;
  const context = { signal: new AbortController().signal };
  await assert.rejects(readReflexOutcomes(context, runtime), /\[MINECRAFT_DISCONNECTED\] socket closed/);
});

/** Model a local runtime that publishes one encounter once the body is idle. */
function encounterRuntime(isBusy: () => boolean, hasEncounter = () => !isBusy()): scenarioRuntime.Runtime {
  const payload = {
    response: "fight",
    outcome: "target_died",
    reason: "healthy",
    interrupted: null,
    threats: [{ id: 7, name: "skeleton" }],
    healthBefore: 20,
    healthAfter: 20,
    killedTargetIds: [7],
    attacks: 4,
    combatStyles: ["shielded_melee"],
    weaponsUsed: ["iron_sword"],
    shieldRaisedSwings: 0,
    projectileGuards: 1,
    explosions: 0,
    finalPosition: { x: 0, y: 64, z: 0 },
    finalDistances: [{ id: 7, distance: 2 }],
  };
  const receipt: SurvivalReceipt = {
    kind: "outcome", source: "hostile_reflex",
    evidence: { outcome: payload, interrupted: null },
    status: {
      summary: "safe", request: null,
      owner: { current: null, reserved: null, connected: true, transfer: null },
      dangers: [], response: null, decisions: [], budgets: [], answered: [],
      observations: { missing: [], stale: [] },
      policy: { revision: "test", defaults: DEFAULT_SURVIVAL_POLICY, effective: DEFAULT_SURVIVAL_POLICY,
        overrides: [], encounter: null, response: null, settling: false, lastChange: "Default policy.", constraint: null },
      vitals: { health: 20, food: 20, air: null, inWater: false },
      runtime: { liveness: "observed_in_process", observedAt: 1, physicsObservedAt: 1 },
    },
  };
  let read = false;
  return {
    status: () => ({ busy: isBusy() }),
    close: async () => {},
    actions: [{ name: "read_recent_events" }],
    run: async () => {
      const events = read || !hasEncounter() ? [] : [{
        type: "survival_outcome",
        eventId: 1,
        botId: "TestBot",
        observedAt: "now",
        summary: "fight finished",
        payload: receipt,
      }];
      read ||= events.length > 0;
      return {
        result: {
          status: "succeeded",
          source: { queryIds: ["test"] },
          readThroughEventId: read ? 1 : 0,
          remainingEventCount: 0,
          events,
        },
      };
    },
  } as unknown as scenarioRuntime.Runtime;
}

for (const ticksPerSecond of [20, 10]) {
  for (const encounterArrives of [false, true]) {
    const phase = encounterArrives ? "returns one encounter after the runtime settles at +200 ticks" : "gives a busy runtime 400 ticks";
    test(`awaitEncounters ${phase} at ${ticksPerSecond} tps`, async () => {
      const clock = createFakeClock({ mode: "mocked" });
      using _timers = clock.install();
      const { bot, server } = createFakeBot({ clock, server: { ticksPerSecond } });
      const context = { bot, signal: new AbortController().signal };
      const startAge = server.age;
      const msPerTick = 1_000 / ticksPerSecond;
      const runtime = encounterRuntime(() => !encounterArrives || server.age < startAge + 200);
      const encounters = await clock.settle(awaitEncounters(context, runtime, 1, 400), 400 * msPerTick + 1_000);
      if (encounterArrives) {
        assert.deepEqual(encounters.map(({ outcome }) => outcome), ["target_died"]);
        assert.ok([200, 220].includes(server.age - startAge), `settled at age +${server.age - startAge}`);
        assert.ok(clock.now() >= 200 * msPerTick && clock.now() <= 220 * msPerTick);
      } else {
        assert.deepEqual(encounters, []);
        assert.equal(server.age - startAge, 400, "the encounter observation spent all 400 server ticks");
        assert.equal(clock.now(), 400 * msPerTick);
      }
    });
  }
}

test("an encounter settled during the final observation sleep is still read", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const { bot, server } = createFakeBot({ clock });
  const context = { bot, signal: new AbortController().signal };
  const startAge = server.age;
  const runtime = encounterRuntime(() => server.age < startAge + 40);
  const encounters = await clock.settle(awaitEncounters(context, runtime, 1, 40), 3_000);
  assert.equal(encounters.length, 1);
  assert.equal(encounters[0]?.outcome, "target_died");
});

for (const { exit, ticksPerSecond } of [
  { exit: "success", ticksPerSecond: 20 },
  { exit: "success", ticksPerSecond: 10 },
  { exit: "frozen success", ticksPerSecond: 20 },
  { exit: "budget", ticksPerSecond: 20 },
  { exit: "stall", ticksPerSecond: 20 },
  { exit: "abort", ticksPerSecond: 20 },
] as const) {
  test(`hurt releases its health listener and wait after ${exit} at ${ticksPerSecond} tps`, async () => {
    const clock = createFakeClock({ mode: "mocked" });
    using _timers = clock.install();
    const { bot, combat, server } = createFakeBot({ clock, server: { ticksPerSecond } });
    const controller = new AbortController();
    const context = { bot, signal: controller.signal };
    const added = listenersAddedSince(bot);
    const startAge = server.age;
    let settlements = 0;
    if (exit === "stall" || exit === "frozen success") server.stop();
    const wounded = hurt(context, 12);
    const count = () => { settlements++; };
    void wounded.then(count, count);

    if (exit === "success") {
      const remove = server.onTick(() => {
        if (server.gameTime < startAge + 60) return;
        combat.setHealth(12);
        remove();
      });
      const packetMs = 60_000 / ticksPerSecond;
      await clock.advance(packetMs - 50);
      assert.equal(settlements, 0);
      assert.equal(await clock.settle(wounded, 100), true, "the health read stays open for the packet after 60 server ticks");
      assert.equal(bot.health, 12);
      assert.equal(server.age - startAge, 60);
      assert.ok(clock.now() >= packetMs);
    } else if (exit === "frozen success") {
      await clock.advance(100);
      assert.equal(settlements, 0);
      combat.setHealth(12);
      assert.equal(await clock.settle(wounded, 100), true, "a health packet can answer without a new time packet");
      assert.equal(server.age, startAge);
    } else if (exit === "budget") {
      assert.equal(await clock.settle(wounded, 5_100), false);
      assert.equal(server.age - startAge, 100);
    } else if (exit === "stall") {
      const failure = assert.rejects(wounded, {
        message: "poll window: the server's world age stood still for 30 s after 0 of 100 ticks",
      });
      await clock.advance(29_950);
      assert.equal(settlements, 0);
      await clock.advance(50);
      await failure;
      assert.equal(server.age, startAge);
    } else {
      const reason = new Error("cancelled health arrangement");
      const failure = assert.rejects(wounded, (error) => error === reason);
      await clock.advance(150);
      controller.abort(reason);
      combat.setHealth(12);
      await clock.settle(failure, 20);
    }

    const assertClean = () => {
      assert.equal(added("health"), 0, "no health listener left");
      assert.equal(added("physicsTick"), 0);
      assert.equal(added("time"), 0);
      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
      assert.equal(clock.pendingTimers(), 0);
      assert.equal(clock.pendingGlobalTimers(), 0);
      assert.equal(settlements, 1);
    };
    assertClean();
    combat.setHealth(11);
    await clock.advance(60_000);
    assertClean();
  });
}

/** The fake receives the same wall cells as the closed-cover scenario's arrangement. */
function closedShelterCells() {
  const cells: Record<string, "nether_bricks"> = { "0,-58,0": "nether_bricks" };
  for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    for (const y of [-60, -59]) cells[`${x},${y},${z}`] = "nether_bricks";
  }
  return cells;
}

for (const phase of ["closed", "in flight before opening", "open"] as const) {
  test(`closed-cover judges an encounter from the ${phase} phase`, async () => {
    const clock = createFakeClock({ mode: "mocked" });
    using _timers = clock.install();
    const { bot, server, world } = createFakeBot({
      clock, position: new Vec3(0.5, -60, 0.5), cells: closedShelterCells(),
    });
    const start = server.gameTime;
    const busy = () => phase === "in flight before opening" && server.gameTime >= start + 640 && server.gameTime < start + 720;
    let opened = false;
    bot.chat = () => server.answer(() => {
      opened = true;
      world.setCell(new Vec3(1, -60, 0), "air");
      world.setCell(new Vec3(1, -59, 0), "air");
    });
    const receiptReady = () => phase === "open" ? opened : server.gameTime >= start + (phase === "closed" ? 200 : 720);
    const attach = spyOn(scenarioRuntime, "openRuntime").mockResolvedValue(encounterRuntime(busy, receiptReady));
    try {
      const context = { bot, signal: new AbortController().signal } as unknown as MineAiScenarioContext;
      const result = await clock.settle(closedCover(context), 60_000);
      assert.equal(result.status, phase === "open" ? "succeeded" : "failed", "only an encounter from open cover can pass");
      assert.equal(opened, phase === "open", "the fixture opens only if the closed phase was quiet");
    } finally {
      attach.mockRestore();
    }
  });
}

for (const { tick, status } of [
  { tick: 290, status: "succeeded" }, { tick: 300, status: "succeeded" }, { tick: 301, status: "failed" },
]) {
  test(`hurt-in-water judges a receipt at +${tick} ticks with a 300-tick window`, async () => {
    const clock = createFakeClock({ mode: "mocked" });
    using _timers = clock.install();
    const { bot, server } = createFakeBot({
      clock, health: 6, cells: { "0,64,0": "water", "0,65,0": "water" }, simulatePhysics: true,
    });
    await clock.advance(50);
    const start = server.age;
    const attach = spyOn(scenarioRuntime, "openRuntime").mockResolvedValue(
      encounterRuntime(() => false, () => server.gameTime >= start + tick),
    );
    try {
      const context = {
        bot, signal: new AbortController().signal, scenario: { params: { hurtTo: 6, waitTicks: 300, statusLimitMs: 2000 } },
      } as unknown as MineAiScenarioContext;
      const result = await clock.settle(hurtInWater(context), 16_000);
      assert.equal(result.status, status, result.detail ?? "water fixture result");
    } finally {
      attach.mockRestore();
    }
  });
}
