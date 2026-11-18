// The fire-contact fixture observes a full server window, even when its runtime has no fire to respond to.
import assert from "node:assert/strict";
import test from "node:test";
import { mock } from "bun:test";
import { createFakeBot, createFakeClock, listenersAddedSince } from "../../../src/test-support/fake-bot/index.ts";
import type { MineAiScenarioContext } from "../../src/scenario-client.ts";
import * as originalRuntime from "../../src/runtime.ts";

const realStandStill = originalRuntime.standStill;
const realOpenRuntime = originalRuntime.openRuntime;

for (const rate of [20, 10]) {
  for (const end of ["ticks", "death", "stopped", "abort", "handshake", "handshake-stopped", "handshake-abort", "handshake-death"] as const) {
    test(`fire contact at ${rate} tps observes server ticks and cleans up on ${end}`, async () => {
      const clock = createFakeClock({ mode: "mocked" });
      using _timers = clock.install();
      const { bot, server } = createFakeBot({ clock, server: { ticksPerSecond: rate, startAge: 1_000 } });
      const added = listenersAddedSince(bot);
      const controller = new AbortController();
      const handshake = end.startsWith("handshake");
      if (handshake) {
        bot.physicsEnabled = false;
        bot.entity.onGround = false;
      }
      const stopLanding = server.onTick(() => {
        if (clock.now() >= 4_000) bot.entity.onGround = true;
      });
      let disposed = 0;
      mock.module("../../src/runtime.ts", () => ({ ...originalRuntime,
        standStill: async () => true,
        openRuntime: async () => ({
          status: () => ({ survival: { owner: {
            current: end === "handshake" && clock.now() >= 3_000 ? "hostile_reflex" : null,
          } } }),
          [Symbol.asyncDispose]: async () => { disposed++; },
        }),
      }));
      try {
        const { run } = await import("./soul-fire-contact.ts");
        const pending = run({ bot, signal: controller.signal, scenario: { params: { duringCombat: handshake } } } as unknown as MineAiScenarioContext);
        const outcome = pending.then(result => ({ result, error: undefined }), error => ({ result: undefined, error }));
        await clock.advance(1_000);
        if (end === "death" || end === "handshake-death") bot.emit("death");
        if (end === "stopped" || end === "handshake-stopped") server.stop();
        if (end === "abort" || end === "handshake-abort") controller.abort(new Error("fixture cancelled"));
        const settled = await clock.settle(outcome, 60_000);
        if (end === "ticks" || end === "handshake") {
          assert.ok(bot.time.age! >= 1_240, `observation ended early at world age ${bot.time.age}`);
          assert.ok(settled.result, "a full observation returns a verdict");
          if (handshake) assert.ok(clock.now() >= 4_000 + 240_000 / rate, "the observation follows combat readiness and landing");
        } else if (end === "death") {
          assert.equal(settled.result?.status, "failed");
          assert.ok(bot.time.age! <= 1_000 + rate, "death does not wait for more server time");
        } else {
          assert.ok(settled.error, `${end} must reject, never finish an unobserved window`);
        }
        assert.equal(disposed, 1);
        for (const event of ["blockUpdate", "death"]) assert.equal(added(event), 0);
        assert.equal(clock.pendingGlobalTimers(), 0);
        assert.equal(clock.pendingTimers(), 0);
        await clock.advance(100_000);
        assert.equal(disposed, 1);
        assert.equal(clock.pendingGlobalTimers(), 0);
        assert.equal(clock.pendingTimers(), 0);
      } finally {
        stopLanding();
        mock.restore();
        mock.module("../../src/runtime.ts", () => ({ ...originalRuntime, standStill: realStandStill, openRuntime: realOpenRuntime }));
      }
    });
  }
}
