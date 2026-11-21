// The settled-counts receipts drain hunger through the shared server-tick `starve`, not a client-tick copy.
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { createFakeBot, createFakeClock, listenersAddedSince } from "../../../src/test-support/fake-bot/index.ts";
import { starve as hungerStarve } from "../../flat/survival/hunger.ts";
import type { MineAiScenarioContext } from "../../src/scenario-client.ts";
import * as settledCounts from "./settled-counts.ts";

const RATES = [20, 10];
/** The fake's world age at the start of each case (`server.startAge`). */
const START_AGE = 1_000;

function fixture(rate: number) {
  const clock = createFakeClock({ mode: "mocked" });
  const timers = clock.install();
  const harness = createFakeBot({ clock, server: { startAge: START_AGE, ticksPerSecond: rate }, health: 20, food: 20 });
  const controller = new AbortController();
  const added = listenersAddedSince(harness.bot);
  const clientAdded = listenersAddedSince(harness.bot._client);
  const chat: string[] = [];
  harness.bot.chat = (line: string) => void chat.push(line);
  const offs: (() => void)[] = [];
  /** Run `action` on the first server tick `offset` ticks after now (server ticks, not clock time). */
  const at = (offset: number, action: () => void) => {
    const due = harness.server.gameTime + offset;
    let done = false;
    offs.push(harness.server.onTick(() => {
      if (done || harness.server.gameTime < due) return;
      done = true;
      action();
    }));
  };
  const context = { bot: harness.bot, signal: controller.signal, log: () => {}, progress: () => {},
    scenario: { params: {} } } as unknown as MineAiScenarioContext;
  return {
    ...harness, clock, controller, context, at,
    cleared: () => chat.filter((line) => line.startsWith("/effect clear")).length,
    given: () => chat.filter((line) => line.startsWith("/effect give")).length,
    /** Each exit leaves no timer, no listener on the bot, its client or the signal. */
    async assertClean() {
      offs.forEach((off) => off());
      const check = () => {
        for (const event of harness.bot.eventNames()) assert.equal(added(String(event)), 0, `bot ${String(event)}`);
        for (const event of harness.bot._client.eventNames()) assert.equal(clientAdded(String(event)), 0, `client ${String(event)}`);
        assert.equal(getEventListeners(controller.signal, "abort").length, 0, "abort listener");
        assert.equal(clock.pendingTimers(), 0, "clock timers");
        assert.equal(clock.pendingGlobalTimers(), 0, "global timers");
      };
      check();
      await clock.advance(60_000);
      check();
      timers[Symbol.dispose]();
    },
  };
}

const msFor = (rate: number, ticks: number) => (ticks / rate) * 1_000;

for (const rate of RATES) {
  // At 10 tps the old client-tick copy gave up after 1 200 client ticks = 60 s = +600 server ticks, before +800.
  test(`starve reaches 16 when food drops at +800 server ticks and clears the effect once, at ${rate} tps`, async () => {
    const f = fixture(rate);
    f.at(800, () => f.combat.setHealth(20, 16));
    const reached = await f.clock.settle(settledCounts.starve(f.context, 16), msFor(rate, 2_400));
    assert.equal(reached, true, "starve reached 16");
    assert.equal(f.given(), 1);
    assert.equal(f.cleared(), 1);
    assert.ok(f.server.gameTime >= START_AGE + 800, "food dropped at +800 server ticks");
    await f.assertClean();
  });

  test(`starve aborted at fake 2 s rejects with the reason and clears the effect once, at ${rate} tps`, async () => {
    const f = fixture(rate);
    const reason = new Error("cancelled receipts");
    const window = settledCounts.starve(f.context, 16);
    const rejected = assert.rejects(window, (error) => error === reason);
    await f.clock.advance(2_000);
    f.controller.abort(reason);
    await f.clock.settle(rejected, 5_000);
    assert.equal(f.cleared(), 1, "the effect is cleared on an abort");
    await f.assertClean();
  });

}

// A stopped world age counts no ticks at any rate, so one case covers it.
test("starve on a stopped world age gives up with food unchanged and clears the effect", async () => {
  const f = fixture(20);
  f.server.stop();
  const reached = await f.clock.settle(settledCounts.starve(f.context, 16), 60_000);
  assert.equal(reached, false);
  assert.equal(f.cleared(), 1);
  await f.assertClean();
});

test("the receipts' starve is the shared helper itself, so a later local copy fails", () => {
  assert.equal(settledCounts.starve, hungerStarve);
});
