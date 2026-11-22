// Pool cleanup and air confirmations allow slow server ticks, with a bound when its clock stops.
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { scenarioDefinitionSchema } from "mine-labs";
import { createFakeBot, createFakeClock } from "../../../src/test-support/fake-bot/index.ts";
import type { FakeServer } from "../../../src/test-support/fake-bot/fake-server.ts";
import { watch } from "../../../src/test-support/pending.ts";
import { protectedRegion } from "../../../src/test-support/protected-region.ts";
import { pendingLifeSavingPlacements, recordLifeSavingPlacement, removeLifeSavingPlacements } from "../../../src/world/life-saving-placements.ts";
import { setProtectedRegionsProvider } from "../../../src/world/protected-regions.ts";
import { scenarioTestContext } from "../scenario-test-context.ts";
import { serverRemoved, waitForPoolCleanup } from "./lava-pool-region.ts";
import { DRIVER_CLOCK_STOPPED_MS } from "./server-ticks.ts";

// 20 and 10 tps are the rates the waits must hold at; 5 tps is the stress rate of add-scenario-test S2. Its rows stay in
// this file, so a red row fails it like any other.
const RATES = [20, 10, 5] as const;

function rateName(rate: number): string {
  return rate === 5 ? `${rate} tps (stress, S2)` : `${rate} tps`;
}

/** Run `answer` on the server tick whose game time is `tick`, once (the tick, not the wall time, decides the answer). */
function answerOnTick(server: FakeServer, tick: number, answer: () => void): void {
  const off = server.onTick(() => {
    if (server.gameTime !== tick) return;
    off();
    answer();
  });
}

// The air window is 40 + 20 ticks of world age from the cached age at the call; the cached age is 10 ticks stale at the
// call (190 ticks in, time packets every 20), so the window ends 50 ticks after the call. 49 is inside it, 51 is past it.
const AIR_ROWS = [
  { name: "late", answerAtTick: 30, answered: true },
  { name: "window edge in", answerAtTick: 49, answered: true },
  { name: "window edge out", answerAtTick: 51, answered: false },
  { name: "missing", answerAtTick: null, answered: false },
  { name: "stopped", answerAtTick: null, answered: false },
] as const;

for (const rate of RATES) {
  for (const row of AIR_ROWS) {
    test(`air confirmation ${row.name} at ${rateName(rate)} follows server age and removes its listener`, async () => {
      const msPerTick = 1_000 / rate;
      const clock = createFakeClock({ mode: "mocked" });
      using _timers = clock.install();
      const { bot, server } = createFakeBot({ clock, server: { ticksPerSecond: rate } });
      bot.chat = () => {};
      const context = scenarioTestContext({
        bot, scenario: scenarioDefinitionSchema.parse({ goal: { kind: "completion" } }),
        call: async () => assert.fail("air confirmation runs no action"),
      });
      await clock.advance(190 * msPerTick);
      const startTick = server.gameTime;
      // tellraw emits messagestr: chat.js:131-143; the real pool scenario proves the conditional air answer.
      const ChatMessage = (require("prismarine-chat") as typeof import("prismarine-chat").default)(bot.version);
      const arrivals: { readonly ms: number; readonly ticks: number }[] = [];
      if (row.answerAtTick !== null) {
        answerOnTick(server, startTick + row.answerAtTick, () => {
          arrivals.push({ ms: clock.now(), ticks: server.gameTime - startTick });
          bot.emit("messagestr", "pool-air-0", "system", new ChatMessage("pool-air-0"));
        });
      }
      if (row.name === "stopped") server.stop();
      const before = bot.listenerCount("messagestr");
      const timersBefore = clock.pendingTimers();
      const callMs = clock.now();
      const pending = serverRemoved(context, [new Vec3(1, 64, 0)], clock.sleep);
      const state = watch(pending);
      await clock.advance(20 * msPerTick);
      assert.equal(state.over, false, `at ${rateName(rate)} 20 ticks after the call the answer is still awaited`);
      const result = await clock.settle(pending, 30_000);
      const endedTicks = server.gameTime - startTick;
      assert.equal(result, row.answered, `at ${rateName(rate)} ${row.name}: the window ends at ${endedTicks} ticks after the call`);
      if (row.name === "missing") assert.ok(endedTicks >= 40, `at ${rateName(rate)} a stale entry packet cannot shorten the answer window`);
      if (row.name === "stopped") {
        assert.equal(clock.now() - callMs, DRIVER_CLOCK_STOPPED_MS, `at ${rateName(rate)} a stopped server ends the wait at the stall bound`);
        assert.equal(endedTicks, 0, `at ${rateName(rate)} the stopped world age does not move`);
      }
      // T6: past the old deadline nothing fires: the late answer, if any, arrives now, after the wait has ended.
      await clock.advance(100 * msPerTick);
      if (row.answerAtTick !== null) {
        assert.deepEqual(arrivals, [{ ms: callMs + row.answerAtTick * msPerTick, ticks: row.answerAtTick }],
          `at ${rateName(rate)} ${row.name}: the answer arrives at ${row.answerAtTick} ticks, ${row.answerAtTick * msPerTick} ms after the call`);
      }
      assert.equal(bot.listenerCount("messagestr"), before, `at ${rateName(rate)} ${row.name}: the listener is removed`);
      assert.equal(clock.pendingTimers(), timersBefore, `at ${rateName(rate)} ${row.name}: no timer is left`);
      assert.equal(result, row.answered, `at ${rateName(rate)} ${row.name}: the result does not change after the window`);
    });
  }
}

for (const rate of RATES) {
  for (const outcome of ["removed", "pending", "stopped"] as const) {
    test(`pool placement ${outcome} at ${rateName(rate)} waits up to 600 server ticks`, async () => {
      const msPerTick = 1_000 / rate;
      const clock = createFakeClock({ mode: "mocked" });
      using _timers = clock.install();
      const { bot, server, world } = createFakeBot({ clock, server: { ticksPerSecond: rate }, cells: { "1,64,0": "cobblestone" } });
      const cell = new Vec3(1, 64, 0);
      setProtectedRegionsProvider(bot, () => [protectedRegion({
        regionId: 1, owner: "Builder", label: "pool", dimension: "overworld", min: cell, max: cell,
      })]);
      recordLifeSavingPlacement(bot, cell, "block");
      await clock.advance(190 * msPerTick);
      const startTick = server.gameTime;
      if (outcome === "stopped") server.stop();
      const callMs = clock.now();
      const timersBefore = clock.pendingTimers();
      const pending = waitForPoolCleanup(bot, clock.sleep);
      if (outcome === "stopped") {
        await clock.settle(pending, DRIVER_CLOCK_STOPPED_MS + 10_000);
        assert.equal(clock.now() - callMs, DRIVER_CLOCK_STOPPED_MS, `at ${rateName(rate)} a stopped server ends the cleanup wait at the stall bound`);
        assert.equal(server.gameTime, startTick, `at ${rateName(rate)} the stopped world age does not move`);
        await clock.advance(100 * msPerTick, 1_000);
        assert.equal(server.gameTime, startTick, `at ${rateName(rate)} still stopped past the stall bound`);
        assert.equal(clock.pendingTimers(), timersBefore, `at ${rateName(rate)} the stopped cleanup leaves no timer`);
        return;
      }
      const state = watch(pending);
      await clock.advance(300 * msPerTick, 1_000);
      assert.equal(state.over, false, `at ${rateName(rate)} 300 ticks into the cleanup window the wait is not over`);
      await clock.advance(280 * msPerTick, 1_000);
      assert.equal(state.over, false, `at ${rateName(rate)} 580 ticks into the cleanup window a stale entry packet cannot shorten it`);
      const changedAt = clock.now();
      const changedTick = server.gameTime - startTick;
      if (outcome === "removed") {
        world.setCell(cell, "air");
        await removeLifeSavingPlacements(bot, new AbortController().signal);
      }
      await clock.settle(pending, 10_000);
      const endedTicks = server.gameTime - startTick;
      const ledgerAtEnd = pendingLifeSavingPlacements(bot).length;
      if (outcome === "removed") {
        assert.ok(clock.now() - changedAt <= 50, `at ${rateName(rate)} clearing the ledger ends the wait within 50 ms`);
        assert.ok(endedTicks - changedTick <= 1, `at ${rateName(rate)} clearing the ledger ends the wait within a tick`);
        assert.equal(ledgerAtEnd, 0, `at ${rateName(rate)} the removed placement is out of the ledger`);
      } else {
        // The window is 600 + 20 ticks of world age from the cached age: it ends after 600 ticks past the call and before 620 (one packet margin more).
        assert.ok(endedTicks >= 600, `at ${rateName(rate)} the pending ledger gets at least 600 actual server ticks, ended at ${endedTicks}`);
        assert.ok(endedTicks < 620, `at ${rateName(rate)} the pending ledger's window ends by 620 ticks, ended at ${endedTicks}`);
        assert.equal(ledgerAtEnd, 1, `at ${rateName(rate)} the pending placement is still in the ledger at expiry`);
      }
      // T6: past the old deadline nothing else changes: the ledger, the timers and the world stay as the wait left them.
      await clock.advance(100 * msPerTick, 1_000);
      assert.equal(pendingLifeSavingPlacements(bot).length, ledgerAtEnd, `at ${rateName(rate)} the ledger does not change after the wait ends`);
      assert.equal(clock.pendingTimers(), timersBefore, `at ${rateName(rate)} the wait leaves no timer behind`);
    });
  }
}
